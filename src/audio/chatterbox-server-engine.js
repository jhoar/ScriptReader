import { readBoundedResponseBlob, readBoundedResponseJson } from '../utils/bounded-response.js';
import { loadChatterboxServerEndpoint, normalizeChatterboxServerEndpoint } from '../utils/credentials.js';
import { getAudioContext } from './audio-context.js';
import { chatterboxRenderStore, decodePcm16 } from './chatterbox-render-store.js';
import { getChatterboxVoiceSample, listChatterboxVoices } from './chatterbox-voice-store.js';
import { ENGINE_IDS } from './engine-contract.js';

const MAX_VOICES = 256;
const MAX_WAV_BYTES = 8 * 1024 * 1024;
const MAX_AUDIO_SECONDS = 60;
const MAX_CACHED_SECONDS = 1500;
const MAX_REFERENCE_FILES = 512;
const MAX_REFERENCE_SECONDS = 30;
const REFERENCE_SAMPLE_RATE = 24000;
const MAX_REFERENCE_CACHE_ENTRIES = 128;
let discoveredVoices = [];

export function getChatterboxServerVoices() {
  return discoveredVoices;
}

function validAudioFilename(filename) {
  return (
    typeof filename === 'string' &&
    /^[^/\\]{1,128}\.(wav|mp3)$/i.test(filename) &&
    ![...filename].some((char) => char.charCodeAt(0) < 32)
  );
}

function normalizeVoices(data) {
  if (!Array.isArray(data) || data.length > MAX_VOICES) throw new Error('Chatterbox returned an invalid voice list.');
  const seen = new Set();
  const voices = [];
  for (const item of data) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const filename = typeof item.filename === 'string' ? item.filename.trim() : '';
    const displayName = typeof item.display_name === 'string' ? item.display_name.trim() : '';
    if (!validAudioFilename(filename) || seen.has(filename)) continue;
    seen.add(filename);
    voices.push({
      id: filename,
      name: displayName && displayName.length <= 128 ? displayName : filename,
      sex: 'Unspecified',
      ageGroup: 'Unspecified',
      accent: 'Unspecified',
      tone: 'Local Chatterbox server voice',
      description: 'Predefined voice from the local Chatterbox server.',
      avatarBg: '#343027',
      suggestedRoles: [],
      defaultPitch: 1,
      defaultSpeed: 1,
      sampleLine: 'This is a local Chatterbox server voice.',
    });
  }
  if (data.length > 0 && voices.length === 0) throw new Error('Chatterbox returned an invalid voice list.');
  return voices;
}

function abortError() {
  return new DOMException('aborted', 'AbortError');
}

function normalizeReferenceFiles(data) {
  if (!Array.isArray(data) || data.length > MAX_REFERENCE_FILES || !data.every(validAudioFilename)) {
    throw new Error('Chatterbox returned an invalid reference-file list.');
  }
  return new Set(data);
}

function encodeReferenceWav(samples) {
  if (
    !(samples instanceof Float32Array) ||
    samples.length < REFERENCE_SAMPLE_RATE ||
    samples.length > REFERENCE_SAMPLE_RATE * MAX_REFERENCE_SECONDS
  ) {
    throw new Error('This Studio voice has an invalid reference recording. Add it again in casting.');
  }
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  view.setUint32(0, 0x52494646, false);
  view.setUint32(4, bytes.byteLength - 8, true);
  view.setUint32(8, 0x57415645, false);
  view.setUint32(12, 0x666d7420, false);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, REFERENCE_SAMPLE_RATE, true);
  view.setUint32(28, REFERENCE_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(36, 0x64617461, false);
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true);
  }
  return bytes;
}

async function referenceUploadName(voiceId, wav) {
  if (!globalThis.crypto?.subtle) throw new Error('Secure browser hashing is required to sync Studio voices.');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', wav);
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const idBytes = new TextEncoder().encode(voiceId);
  const idDigest = await globalThis.crypto.subtle.digest('SHA-256', idBytes);
  const idHex = [...new Uint8Array(idDigest)]
    .slice(0, 8)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `scriptreader-${idHex}-${hex}.wav`;
}

export class ChatterboxServerEngine {
  constructor({
    getEndpoint = loadChatterboxServerEndpoint,
    fetchImpl = (...args) => fetch(...args),
    renderStore = chatterboxRenderStore,
    publishVoices = true,
    getReferenceSample = getChatterboxVoiceSample,
    getStudioVoices = listChatterboxVoices,
  } = {}) {
    this.getEndpoint = getEndpoint;
    this.fetch = fetchImpl;
    this.renderStore = renderStore;
    this.publishVoices = publishVoices;
    this.getReferenceSample = getReferenceSample;
    this.getStudioVoices = getStudioVoices;
    this.isReady = false;
    this.isLoading = false;
    this.phase = 'idle';
    this.statusMessage = 'Not connected';
    this.voices = [];
    this.audioCache = new Map();
    this.cachedSeconds = 0;
    this.pending = new Map();
    this.queue = [];
    this.active = null;
    this.listeners = new Set();
    this.generation = 0;
    this.initController = null;
    this.endpoint = null;
    this.referenceFiles = null;
    this.referenceUploads = new Map();
  }

  get capabilities() {
    return {
      id: ENGINE_IDS.CHATTERBOX_SERVER,
      label: 'Local GPU (Chatterbox Server)',
      supportsSpeed: false,
      supportsInstructions: false,
      isLocal: true,
      metered: false,
      nativeSampleRate: 24000,
      maxChunkChars: 350,
      concurrency: 1,
      onUnavailable: 'error',
    };
  }

  resolveVoiceId(profile) {
    return profile?.id || this.voices[0]?.id || '';
  }

  resolveVoiceCacheId(profile) {
    const revision = profile?.renderRevision ? `@${profile.renderRevision}` : '';
    return `${this.resolveVoiceId(profile)}${revision}@server:${normalizeChatterboxServerEndpoint(this.getEndpoint())}`;
  }

  onProgress(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  _notify(phase, message, error = null) {
    this.phase = phase;
    this.statusMessage = message;
    for (const listener of this.listeners) {
      try {
        listener({ phase, message, error });
      } catch (notice) {
        console.warn('Chatterbox progress listener notice:', notice);
      }
    }
  }

  async init() {
    const endpoint = normalizeChatterboxServerEndpoint(this.getEndpoint());
    if (this.isReady && this.endpoint === endpoint) return;
    this.release();
    const generation = this.generation;
    const controller = new AbortController();
    this.initController = controller;
    this.isLoading = true;
    this._notify('loading', `Connecting to Chatterbox at ${endpoint}…`);
    try {
      const response = await this.fetch(`${endpoint}/get_predefined_voices`, { signal: controller.signal });
      if (!response.ok) throw new Error(`Chatterbox returned HTTP ${response.status}.`);
      const data = await readBoundedResponseJson(response, { maxBytes: 64 * 1024, signal: controller.signal });
      const voices = normalizeVoices(data);
      if (generation !== this.generation || controller.signal.aborted) throw abortError();
      this.endpoint = endpoint;
      this.voices = voices;
      if (this.publishVoices) discoveredVoices = voices;
      this.isReady = true;
      this.isLoading = false;
      this._notify('ready', `Connected · ${voices.length} voice${voices.length === 1 ? '' : 's'} available`);
    } catch (error) {
      if (generation !== this.generation || controller.signal.aborted) throw abortError();
      this.isReady = false;
      this.isLoading = false;
      const useful = new Error(
        `Could not connect to Chatterbox at ${endpoint}. Start Chatterbox-TTS-Server and try again.`,
      );
      useful.cause = error;
      this._notify('error', useful.message, useful);
      throw useful;
    } finally {
      if (this.initController === controller) this.initController = null;
    }
  }

  getCached(key) {
    return this.audioCache.get(key) || null;
  }
  has(key) {
    return this.audioCache.has(key);
  }
  isPending(key) {
    return this.pending.has(key);
  }

  _cache(key, buffer) {
    const previous = this.audioCache.get(key);
    if (previous) this.cachedSeconds -= previous.duration || 0;
    this.audioCache.delete(key);
    this.audioCache.set(key, buffer);
    this.cachedSeconds += buffer.duration || 0;
    while (this.cachedSeconds > MAX_CACHED_SECONDS && this.audioCache.size > 1) {
      const oldest = this.audioCache.keys().next().value;
      this.cachedSeconds -= this.audioCache.get(oldest).duration || 0;
      this.audioCache.delete(oldest);
    }
  }

  _decodeStored(stored) {
    const context = getAudioContext();
    if (!context) throw new Error('Web Audio is unavailable in this browser.');
    const samples = decodePcm16(stored.audio);
    const buffer = context.createBuffer(1, samples.length, stored.sampleRate);
    buffer.copyToChannel(samples, 0);
    return buffer;
  }

  async _loadReferenceFiles(endpoint, signal) {
    const response = await this.fetch(`${endpoint}/get_reference_files`, { signal });
    if (!response.ok) throw new Error(`Could not list Chatterbox reference files (HTTP ${response.status}).`);
    const data = await readBoundedResponseJson(response, { maxBytes: 64 * 1024, signal });
    return normalizeReferenceFiles(data);
  }

  async _syncReferenceVoice(unit, endpoint, signal, current) {
    const profile = this.getStudioVoices().find((voice) => voice.id === unit.voiceId);
    if (!profile)
      throw new Error('This Studio reference voice is no longer available. Choose another voice in casting.');
    const cacheId = this.resolveVoiceCacheId(profile);
    if (unit.voiceCacheId && unit.voiceCacheId !== cacheId) throw abortError();
    const profileIsCurrent = () =>
      this.getStudioVoices().some((voice) => voice.id === profile.id && this.resolveVoiceCacheId(voice) === cacheId);
    const cachedName = this.referenceUploads.get(cacheId);
    if (cachedName && this.referenceFiles?.has(cachedName) && profileIsCurrent()) return cachedName;

    const samples = await this.getReferenceSample(profile.id);
    if (!current() || !profileIsCurrent()) throw abortError();
    const wav = encodeReferenceWav(samples);
    const filename = await referenceUploadName(profile.id, wav);
    if (!current() || !profileIsCurrent()) throw abortError();
    if (!this.referenceFiles) this.referenceFiles = await this._loadReferenceFiles(endpoint, signal);
    if (!current() || !profileIsCurrent()) throw abortError();
    if (!this.referenceFiles.has(filename)) {
      const form = new FormData();
      form.append('files', new Blob([wav], { type: 'audio/wav' }), filename);
      const response = await this.fetch(`${endpoint}/upload_reference`, { method: 'POST', body: form, signal });
      if (!response.ok) throw new Error(`Chatterbox rejected the reference voice upload (HTTP ${response.status}).`);
      const data = await readBoundedResponseJson(response, { maxBytes: 64 * 1024, signal });
      if (
        !data ||
        !Array.isArray(data.uploaded_files) ||
        !Array.isArray(data.errors) ||
        !data.uploaded_files.includes(filename) ||
        data.errors.length > 0
      ) {
        throw new Error('Chatterbox did not confirm the reference voice upload. Check the server logs.');
      }
      const files = normalizeReferenceFiles(data.all_reference_files);
      if (!files.has(filename)) throw new Error('Chatterbox could not find the uploaded reference voice.');
      this.referenceFiles = files;
    }
    if (!current() || !profileIsCurrent()) throw abortError();
    this.referenceUploads.set(cacheId, filename);
    while (this.referenceUploads.size > MAX_REFERENCE_CACHE_ENTRIES) {
      this.referenceUploads.delete(this.referenceUploads.keys().next().value);
    }
    return filename;
  }

  async _render(entry) {
    const { unit, controller, generation } = entry;
    const signal = controller.signal;
    const current = () => generation === this.generation && !signal.aborted && this.pending.get(unit.key) === entry;
    let stored = null;
    try {
      stored = await this.renderStore?.get(unit.key);
    } catch (error) {
      console.warn('Chatterbox render cache read notice:', error);
    }
    if (!current()) throw abortError();
    if (
      stored?.audio?.length &&
      stored.sampleRate >= 8000 &&
      stored.sampleRate <= 192000 &&
      stored.audio.length <= stored.sampleRate * MAX_AUDIO_SECONDS
    ) {
      const buffer = this._decodeStored(stored);
      if (buffer.duration > 0 && buffer.duration <= MAX_AUDIO_SECONDS) return buffer;
    }
    const endpoint = normalizeChatterboxServerEndpoint(this.getEndpoint());
    if (endpoint !== this.endpoint) throw new Error('Chatterbox server settings changed. Reconnect before rendering.');
    const predefined = this.voices.some((voice) => voice.id === unit.voiceId);
    let referenceName = predefined ? null : await this._syncReferenceVoice(unit, endpoint, signal, current);
    const synthesize = () =>
      this.fetch(`${endpoint}/tts`, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: unit.text,
          voice_mode: predefined ? 'predefined' : 'clone',
          ...(predefined ? { predefined_voice_id: unit.voiceId } : { reference_audio_filename: referenceName }),
          output_format: 'wav',
          split_text: false,
        }),
      });
    let response = await synthesize();
    if (!predefined && response.status === 404 && current()) {
      await response.body?.cancel?.();
      this.referenceFiles = null;
      this.referenceUploads.clear();
      referenceName = await this._syncReferenceVoice(unit, endpoint, signal, current);
      if (!current()) throw abortError();
      response = await synthesize();
    }
    if (!response.ok) throw new Error(`Chatterbox synthesis failed (HTTP ${response.status}).`);
    const blob = await readBoundedResponseBlob(response, { maxBytes: MAX_WAV_BYTES, signal });
    if (!current()) throw abortError();
    const bytes = await blob.arrayBuffer();
    const header = new DataView(bytes);
    if (
      bytes.byteLength < 44 ||
      header.getUint32(0, false) !== 0x52494646 ||
      header.getUint32(8, false) !== 0x57415645
    ) {
      throw new Error('Chatterbox returned invalid WAV audio.');
    }
    const context = getAudioContext();
    if (!context) throw new Error('Web Audio is unavailable in this browser.');
    let buffer;
    try {
      buffer = await context.decodeAudioData(bytes);
    } catch {
      throw new Error('Chatterbox returned WAV audio this browser could not decode.');
    }
    if (!current()) throw abortError();
    if (
      !buffer ||
      !Number.isFinite(buffer.duration) ||
      buffer.duration <= 0 ||
      buffer.duration > MAX_AUDIO_SECONDS ||
      !buffer.length
    ) {
      throw new Error('Chatterbox returned empty or excessively long audio.');
    }
    let audible = false;
    for (let channel = 0; channel < buffer.numberOfChannels && !audible; channel++) {
      const samples = buffer.getChannelData(channel);
      for (let i = 0; i < samples.length; i++) {
        if (Math.abs(samples[i]) > 0.0001) {
          audible = true;
          break;
        }
      }
    }
    if (!audible) throw new Error('Chatterbox returned silent audio.');
    if (this.renderStore) {
      const samples = new Float32Array(buffer.length);
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        const source = buffer.getChannelData(channel);
        for (let i = 0; i < samples.length; i++) samples[i] += source[i] / buffer.numberOfChannels;
      }
      try {
        await this.renderStore.put(unit.key, samples, buffer.sampleRate);
      } catch (error) {
        console.warn('Chatterbox render cache write notice:', error);
      }
      if (!current()) throw abortError();
    }
    return buffer;
  }

  _pump() {
    if (this.active || !this.queue.length) return;
    this.queue.sort((a, b) => a.priority - b.priority);
    const entry = this.queue.shift();
    this.active = entry;
    this._render(entry)
      .then(
        (buffer) => {
          if (this.pending.get(entry.unit.key) !== entry || entry.generation !== this.generation) return;
          this._cache(entry.unit.key, buffer);
          entry.resolve(buffer);
        },
        (error) => {
          if (this.pending.get(entry.unit.key) === entry) entry.reject(error);
        },
      )
      .finally(() => {
        if (this.pending.get(entry.unit.key) === entry) this.pending.delete(entry.unit.key);
        if (this.active === entry) this.active = null;
        this._pump();
      });
  }

  request(unit, priority = 1000) {
    if (!unit?.key || !this.isReady) return null;
    if (this.audioCache.has(unit.key)) return Promise.resolve(this.audioCache.get(unit.key));
    const existing = this.pending.get(unit.key);
    if (existing) {
      existing.priority = Math.min(existing.priority, priority);
      return existing.promise;
    }
    const entry = { unit, priority, generation: this.generation, controller: new AbortController() };
    entry.promise = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });
    this.pending.set(unit.key, entry);
    this.queue.push(entry);
    queueMicrotask(() => this._pump());
    return entry.promise;
  }

  dropPendingExcept(keepKeys = []) {
    const keep = new Set(keepKeys);
    if (this.active && !keep.has(this.active.unit.key)) this.referenceFiles = null;
    for (const [key, entry] of this.pending) {
      if (keep.has(key)) continue;
      entry.controller.abort();
      entry.reject(abortError());
      this.pending.delete(key);
    }
    this.queue = this.queue.filter((entry) => keep.has(entry.unit.key));
    if (this.active && !keep.has(this.active.unit.key)) this.active = null;
    queueMicrotask(() => this._pump());
  }

  clearCache() {
    this.audioCache.clear();
    this.cachedSeconds = 0;
  }

  release() {
    this.generation++;
    this.initController?.abort();
    this.dropPendingExcept([]);
    this.clearCache();
    this.isReady = false;
    this.isLoading = false;
    this.endpoint = null;
    this.voices = [];
    this.referenceFiles = null;
    this.referenceUploads.clear();
    if (this.publishVoices) discoveredVoices = [];
    this._notify('idle', 'Not connected');
  }
}
