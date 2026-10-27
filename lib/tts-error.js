// lib/tts-error.js — provider-neutral error type. Every TTS client throws this (or a
// subclass) so offscreen.js can turn failures into one human message regardless of backend.
export class TtsError extends Error {
  constructor(message, { status = 0, cause } = {}) {
    super(message);
    this.name = "TtsError";
    this.status = status; // HTTP status, or 0 for network-level failure
    if (cause) this.cause = cause;
  }
}
