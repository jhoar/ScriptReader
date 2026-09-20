import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatterboxServerEngine, getChatterboxServerVoices } from '../src/audio/chatterbox-server-engine.js';
import { ENGINE_IDS } from '../src/audio/engine-contract.js';
import { normalizeChatterboxServerEndpoint } from '../src/utils/credentials.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const voiceResponse = (voices = [{ display_name: 'Emily', filename: 'Emily.wav' }]) =>
  new Response(JSON.stringify(voices));
const emptyStore = { get: async () => null, put: async () => {} };
const unit = (key = 'line') => ({ key, text: 'Hello there.', voiceId: 'Emily.wav' });

function wav() {
  const data = new Uint8Array(48);
  const view = new DataView(data.buffer);
  view.setUint32(0, 0x52494646, false);
  view.setUint32(8, 0x57415645, false);
  return data;
}

function makeEngine(fetchImpl, options = {}) {
  return new ChatterboxServerEngine({
    fetchImpl,
    getEndpoint: () => 'http://localhost:8004/',
    renderStore: emptyStore,
    ...options,
  });
}

test('initialization discovers predefined voices and reports ready', async () => {
  const engine = makeEngine(async (url) => {
    assert.equal(url, 'http://localhost:8004/get_predefined_voices');
    return voiceResponse();
  });
  await engine.init();
  assert.equal(engine.isReady, true);
  assert.equal(engine.voices[0].id, 'Emily.wav');
  assert.equal(getChatterboxServerVoices()[0].sex, 'Unspecified');
  assert.match(engine.statusMessage, /1 voice available/);
  assert.equal(engine.capabilities.id, ENGINE_IDS.CHATTERBOX_SERVER);
  engine.release();
});

test('malformed voice list and unreachable server fail cleanly', async () => {
  for (const response of [voiceResponse({ voices: [] }), voiceResponse([{ filename: '../bad.wav' }])]) {
    const engine = makeEngine(async () => response);
    await assert.rejects(engine.init(), /Could not connect to Chatterbox/);
    assert.equal(engine.isReady, false);
  }
  const engine = makeEngine(async () => {
    throw new TypeError('network');
  });
  await assert.rejects(engine.init(), /Start Chatterbox-TTS-Server/);
});

test('synthesis sends predefined voice and decodes WAV for the scheduler', async () => {
  const calls = [];
  const originalWindow = globalThis.window;
  globalThis.window = {
    AudioContext: class {
      createBuffer(_channels, length, sampleRate) {
        return { duration: length / sampleRate, length, sampleRate, copyToChannel() {} };
      }
      async decodeAudioData() {
        const samples = new Float32Array(24000);
        samples[0] = 0.5;
        return {
          duration: 1,
          length: 24000,
          sampleRate: 24000,
          numberOfChannels: 1,
          getChannelData: () => samples,
        };
      }
    },
  };
  try {
    const engine = makeEngine(async (url, options) => {
      calls.push([url, options]);
      return url.endsWith('/tts') ? new Response(wav(), { headers: { 'content-type': 'audio/wav' } }) : voiceResponse();
    });
    await engine.init();
    const first = engine.request(unit());
    assert.equal(first, engine.request(unit(), 1));
    const buffer = await first;
    assert.equal(buffer.duration, 1);
    assert.equal(engine.has('line'), true);
    assert.equal(await engine.request(unit()), buffer);
    assert.equal(calls.filter(([url]) => url.endsWith('/tts')).length, 1);
    assert.deepEqual(JSON.parse(calls[1][1].body), {
      text: 'Hello there.',
      voice_mode: 'predefined',
      predefined_voice_id: 'Emily.wav',
      output_format: 'wav',
      split_text: false,
    });
    engine.release();
  } finally {
    globalThis.window = originalWindow;
  }
});

test('Studio reference is uploaded once and used in clone synthesis', async () => {
  const sample = new Float32Array(24000 * 5).fill(0.25);
  const studioVoice = { id: 'studio-alice', renderRevision: 7 };
  const calls = [];
  const serverFiles = [];
  let uploadedName = '';
  const fetchImpl = async (url, options = {}) => {
    calls.push([url, options]);
    if (url.endsWith('/get_predefined_voices')) return voiceResponse();
    if (url.endsWith('/get_reference_files')) return new Response(JSON.stringify(serverFiles));
    if (url.endsWith('/upload_reference')) {
      const file = options.body.get('files');
      uploadedName = file.name;
      assert.match(uploadedName, /^scriptreader-[a-f0-9]+-[a-f0-9]+\.wav$/);
      assert.equal(new DataView(await file.arrayBuffer()).getUint32(0, false), 0x52494646);
      serverFiles.push(uploadedName);
      return new Response(
        JSON.stringify({ uploaded_files: [uploadedName], all_reference_files: serverFiles, errors: [] }),
      );
    }
    if (url.endsWith('/tts')) return new Response(wav());
    throw new Error(`Unexpected URL ${url}`);
  };
  const options = { getStudioVoices: () => [studioVoice], getReferenceSample: async () => sample };
  const engine = makeEngine(fetchImpl, options);
  await engine.init();
  const voiceCacheId = engine.resolveVoiceCacheId(studioVoice);
  await engine.request({ ...unit('clone-1'), voiceId: studioVoice.id, voiceCacheId });
  await engine.request({ ...unit('clone-2'), voiceId: studioVoice.id, voiceCacheId });
  assert.equal(calls.filter(([url]) => url.endsWith('/upload_reference')).length, 1);
  assert.equal(calls.filter(([url]) => url.endsWith('/get_reference_files')).length, 1);
  assert.deepEqual(JSON.parse(calls.find(([url]) => url.endsWith('/tts'))[1].body), {
    text: 'Hello there.',
    voice_mode: 'clone',
    reference_audio_filename: uploadedName,
    output_format: 'wav',
    split_text: false,
  });
  engine.release();
  const restartedEngine = makeEngine(fetchImpl, options);
  await restartedEngine.init();
  await restartedEngine.request({
    ...unit('clone-after-restart'),
    voiceId: studioVoice.id,
    voiceCacheId: restartedEngine.resolveVoiceCacheId(studioVoice),
  });
  assert.equal(calls.filter(([url]) => url.endsWith('/upload_reference')).length, 1);
  assert.equal(calls.filter(([url]) => url.endsWith('/get_reference_files')).length, 2);
  restartedEngine.release();
});

test('reference revision changes upload filename and render identity', async () => {
  let revision = 1;
  let sample = new Float32Array(24000 * 5).fill(0.25);
  const uploads = [];
  const engine = makeEngine(
    async (url, options = {}) => {
      if (url.endsWith('/get_predefined_voices')) return voiceResponse();
      if (url.endsWith('/get_reference_files')) return new Response(JSON.stringify(uploads));
      if (url.endsWith('/upload_reference')) {
        const name = options.body.get('files').name;
        uploads.push(name);
        return new Response(JSON.stringify({ uploaded_files: [name], all_reference_files: uploads, errors: [] }));
      }
      return new Response(wav());
    },
    {
      getStudioVoices: () => [{ id: 'studio-alice', renderRevision: revision }],
      getReferenceSample: async () => sample,
    },
  );
  await engine.init();
  const firstCacheId = engine.resolveVoiceCacheId({ id: 'studio-alice', renderRevision: revision });
  await engine.request({ ...unit('first'), voiceId: 'studio-alice', voiceCacheId: firstCacheId });
  revision = 2;
  sample = new Float32Array(24000 * 5).fill(0.4);
  const secondCacheId = engine.resolveVoiceCacheId({ id: 'studio-alice', renderRevision: revision });
  await engine.request({ ...unit('second'), voiceId: 'studio-alice', voiceCacheId: secondCacheId });
  assert.notEqual(firstCacheId, secondCacheId);
  assert.equal(uploads.length, 2);
  assert.notEqual(uploads[0], uploads[1]);
  engine.release();
});

test('malformed reference listing and rejected uploads never synthesize', async () => {
  const sample = new Float32Array(24000 * 5).fill(0.25);
  const profile = { id: 'studio-alice', renderRevision: 1 };
  for (const listing of [new Response(JSON.stringify({ files: [] })), new Response(JSON.stringify([]))]) {
    let synthesisCount = 0;
    const engine = makeEngine(
      async (url) => {
        if (url.endsWith('/get_predefined_voices')) return voiceResponse();
        if (url.endsWith('/get_reference_files')) return listing;
        if (url.endsWith('/upload_reference'))
          return new Response(
            JSON.stringify({ uploaded_files: [], all_reference_files: [], errors: [{ error: 'bad audio' }] }),
            { status: 400 },
          );
        synthesisCount++;
        return new Response(wav());
      },
      { getStudioVoices: () => [profile], getReferenceSample: async () => sample },
    );
    await engine.init();
    await assert.rejects(
      engine.request({
        ...unit('clone-error'),
        voiceId: profile.id,
        voiceCacheId: engine.resolveVoiceCacheId(profile),
      }),
      /Chatterbox/,
    );
    assert.equal(synthesisCount, 0);
    engine.release();
  }
});

test('stale reference sample completion cannot upload after replacement', async () => {
  let revision = 1;
  let resolveSample;
  let uploads = 0;
  const engine = makeEngine(
    async (url) => {
      if (url.endsWith('/get_predefined_voices')) return voiceResponse();
      if (url.endsWith('/upload_reference')) uploads++;
      return new Response(JSON.stringify([]));
    },
    {
      getStudioVoices: () => [{ id: 'studio-alice', renderRevision: revision }],
      getReferenceSample: () =>
        new Promise((resolve) => {
          resolveSample = resolve;
        }),
    },
  );
  await engine.init();
  const request = engine.request({
    ...unit('stale-clone'),
    voiceId: 'studio-alice',
    voiceCacheId: engine.resolveVoiceCacheId({ id: 'studio-alice', renderRevision: 1 }),
  });
  await tick();
  revision = 2;
  resolveSample(new Float32Array(24000 * 5).fill(0.25));
  await assert.rejects(request, (error) => error.name === 'AbortError');
  assert.equal(uploads, 0);
  engine.release();
});

test('a dropped upload is reconciled from the server file list before retry', async () => {
  const profile = { id: 'studio-alice', renderRevision: 1 };
  const sample = new Float32Array(24000 * 5).fill(0.25);
  const serverFiles = [];
  let resolveUpload;
  let uploadCount = 0;
  let listCount = 0;
  const engine = makeEngine(
    async (url, options = {}) => {
      if (url.endsWith('/get_predefined_voices')) return voiceResponse();
      if (url.endsWith('/get_reference_files')) {
        listCount++;
        return new Response(JSON.stringify(serverFiles));
      }
      if (url.endsWith('/upload_reference')) {
        uploadCount++;
        const name = options.body.get('files').name;
        serverFiles.push(name);
        return new Promise((resolve) => {
          resolveUpload = () =>
            resolve(
              new Response(
                JSON.stringify({
                  uploaded_files: [name],
                  all_reference_files: serverFiles,
                  errors: [],
                }),
              ),
            );
        });
      }
      return new Response(wav());
    },
    { getStudioVoices: () => [profile], getReferenceSample: async () => sample },
  );
  await engine.init();
  const voiceCacheId = engine.resolveVoiceCacheId(profile);
  const first = engine.request({ ...unit('dropped-clone'), voiceId: profile.id, voiceCacheId });
  first.catch(() => {});
  for (let i = 0; i < 100 && !resolveUpload; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(resolveUpload);
  engine.dropPendingExcept([]);
  await assert.rejects(first, (error) => error.name === 'AbortError');
  resolveUpload();
  await tick();
  await engine.request({ ...unit('replacement-clone'), voiceId: profile.id, voiceCacheId });
  assert.equal(uploadCount, 1);
  assert.equal(listCount, 2);
  engine.release();
});

test('a missing server reference is uploaded again after clone synthesis returns 404', async () => {
  const profile = { id: 'studio-alice', renderRevision: 1 };
  const sample = new Float32Array(24000 * 5).fill(0.25);
  let uploadedName;
  let uploads = 0;
  let synthesisCount = 0;
  const engine = makeEngine(
    async (url, options = {}) => {
      if (url.endsWith('/get_predefined_voices')) return voiceResponse();
      if (url.endsWith('/get_reference_files')) return new Response(JSON.stringify([]));
      if (url.endsWith('/upload_reference')) {
        uploads++;
        uploadedName = options.body.get('files').name;
        return new Response(
          JSON.stringify({ uploaded_files: [uploadedName], all_reference_files: [uploadedName], errors: [] }),
        );
      }
      synthesisCount++;
      return synthesisCount === 1 ? new Response('', { status: 404 }) : new Response(wav());
    },
    { getStudioVoices: () => [profile], getReferenceSample: async () => sample },
  );
  await engine.init();
  await engine.request({
    ...unit('recovered-clone'),
    voiceId: profile.id,
    voiceCacheId: engine.resolveVoiceCacheId(profile),
  });
  assert.equal(uploads, 2);
  assert.equal(synthesisCount, 2);
  engine.release();
});

test('a new engine instance reuses a durable render without another synthesis request', async () => {
  let stored = null;
  let syntheses = 0;
  const renderStore = {
    get: async () => stored,
    put: async (_key, samples, sampleRate) => {
      stored = { audio: new Int16Array(samples.length), sampleRate };
    },
  };
  const fetchImpl = async (url) => {
    if (url.endsWith('/tts')) syntheses++;
    return url.endsWith('/tts') ? new Response(wav()) : voiceResponse();
  };
  const first = makeEngine(fetchImpl, { renderStore });
  await first.init();
  await first.request(unit());
  first.release();
  const second = makeEngine(fetchImpl, { renderStore });
  await second.init();
  const buffer = await second.request(unit());
  assert.equal(buffer.duration, 1);
  assert.equal(syntheses, 1);
  second.release();
});

test('HTTP failure and invalid or empty WAV reject', async () => {
  for (const response of [
    new Response('failed', { status: 500 }),
    new Response(''),
    new Response(new Uint8Array(48)),
  ]) {
    const engine = makeEngine(async (url) => (url.endsWith('/tts') ? response : voiceResponse()));
    await engine.init();
    await assert.rejects(engine.request(unit()), /Chatterbox/);
    engine.release();
  }
});

test('drop cancels requests and a late completion cannot replace a new request', async () => {
  const pending = [];
  const engine = makeEngine((url) =>
    url.endsWith('/tts') ? new Promise((resolve) => pending.push(resolve)) : Promise.resolve(voiceResponse()),
  );
  await engine.init();
  const first = engine.request(unit());
  first.catch(() => {});
  await tick();
  engine.dropPendingExcept([]);
  await assert.rejects(first, (error) => error.name === 'AbortError');
  const second = engine.request(unit());
  second.catch(() => {});
  await tick();
  assert.equal(pending.length, 2);
  pending[0](new Response(wav()));
  await tick();
  assert.equal(engine.isPending('line'), true);
  assert.equal(engine.has('line'), false);
  engine.dropPendingExcept([]);
  await assert.rejects(second, (error) => error.name === 'AbortError');
  pending[1](new Response(wav()));
  engine.release();
});

test('endpoint normalization and cache identities distinguish servers and browser Chatterbox', () => {
  assert.equal(normalizeChatterboxServerEndpoint('http://localhost:8004/'), 'http://localhost:8004');
  assert.throws(() => normalizeChatterboxServerEndpoint('file:///tmp/foo'), /HTTP or HTTPS/);
  assert.throws(() => normalizeChatterboxServerEndpoint('http://localhost:8004/path'), /no path/);
  let endpoint = 'http://localhost:8004';
  const engine = makeEngine(async () => voiceResponse(), { getEndpoint: () => endpoint });
  const first = engine.resolveVoiceCacheId({ id: 'Emily.wav' });
  endpoint = 'http://localhost:8005';
  const second = engine.resolveVoiceCacheId({ id: 'Emily.wav' });
  assert.notEqual(first, second);
  assert.notEqual(ENGINE_IDS.CHATTERBOX_SERVER, ENGINE_IDS.CHATTERBOX);
});
