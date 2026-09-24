export interface RecordingState {
  active: boolean;
  elapsedMs: number;
  level: number;
}

type StateListener = (state: RecordingState) => void;

export class RecordingService {
  private context?: AudioContext;
  private stream?: MediaStream;
  private source?: MediaStreamAudioSourceNode;
  private processor?: ScriptProcessorNode;
  private chunks: Float32Array[] = [];
  private startedAt = 0;
  private ticker?: number;
  private readonly state: RecordingState = { active: false, elapsedMs: 0, level: 0 };
  private listener?: StateListener;

  onState(listener: StateListener): void {
    this.listener = listener;
    listener({ ...this.state });
  }

  async start(): Promise<void> {
    if (this.state.active) return;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone recording is unavailable in this Obsidian window.");
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    this.context = new AudioContext();
    await this.context.resume();
    this.source = this.context.createMediaStreamSource(this.stream);
    this.processor = this.context.createScriptProcessor(4_096, 1, 1);
    this.chunks = [];
    this.processor.onaudioprocess = (event) => {
      if (!this.state.active) return;
      const input = event.inputBuffer.getChannelData(0);
      this.chunks.push(new Float32Array(input));
      let sum = 0;
      for (const sample of input) sum += sample * sample;
      this.state.level = Math.min(1, Math.sqrt(sum / input.length) * 4);
      this.listener?.({ ...this.state });
    };
    this.source.connect(this.processor);
    const silent = this.context.createGain();
    silent.gain.value = 0;
    this.processor.connect(silent);
    silent.connect(this.context.destination);
    this.startedAt = Date.now();
    this.state.active = true;
    this.ticker = window.setInterval(() => {
      this.state.elapsedMs = Date.now() - this.startedAt;
      this.listener?.({ ...this.state });
    }, 200);
    this.listener?.({ ...this.state });
  }

  async stop(): Promise<ArrayBuffer> {
    if (!this.state.active) throw new Error("No lecture recording is active.");
    this.state.active = false;
    if (this.ticker !== undefined) window.clearInterval(this.ticker);
    this.ticker = undefined;
    this.processor?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    const sampleRate = this.context?.sampleRate ?? 48_000;
    await this.context?.close();
    this.context = undefined;
    this.stream = undefined;
    this.source = undefined;
    this.processor = undefined;
    this.state.level = 0;
    this.listener?.({ ...this.state });
    return encodeWav(this.chunks, sampleRate, 16_000);
  }

  dispose(): void {
    this.state.active = false;
    if (this.ticker !== undefined) window.clearInterval(this.ticker);
    this.processor?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    void this.context?.close();
    this.listener = undefined;
  }
}

export function encodeWav(chunks: Float32Array[], inputRate: number, outputRate = 16_000): ArrayBuffer {
  if (!Number.isFinite(inputRate) || inputRate <= 0) throw new Error("The microphone returned an invalid sample rate.");
  const inputLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const outputLength = Math.max(1, Math.round(inputLength * outputRate / inputRate));
  const samples = resample(chunks, inputLength, outputLength);
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  writeText(view, 0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeText(view, 8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, outputRate, true);
  view.setUint32(28, outputRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(view, 36, "data");
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  return buffer;
}

function resample(chunks: Float32Array[], inputLength: number, outputLength: number): Float32Array {
  const input = new Float32Array(inputLength);
  let offset = 0;
  for (const chunk of chunks) { input.set(chunk, offset); offset += chunk.length; }
  const output = new Float32Array(outputLength);
  for (let index = 0; index < outputLength; index += 1) {
    const source = Math.min(inputLength - 1, index * inputLength / outputLength);
    const left = Math.floor(source);
    const right = Math.min(inputLength - 1, left + 1);
    const fraction = source - left;
    output[index] = (input[left] ?? 0) * (1 - fraction) + (input[right] ?? 0) * fraction;
  }
  return output;
}

function writeText(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
}
