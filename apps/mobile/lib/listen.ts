/**
 * Starting and stopping the recognizer for dictation, apart from React so the
 * order of things can be tested. The trouble it solves is the first use: the
 * first start asks for the microphone and speech recognition, the system's
 * prompts come up over the app, and while they're up the sheet re-renders and
 * stops and starts again. A start that waited on a prompt must not start the
 * recognizer after a stop came in behind it, and the start that's current
 * must start it once the prompts are answered.
 *
 * Each start takes a generation; a stop moves it on, and a start whose
 * generation has moved on does nothing when its permission comes back.
 * Starting while already listening, or already asking, does nothing. When
 * the app comes back to the front (the prompts are gone) and listening is
 * still wanted but isn't happening, it starts again.
 */
export interface Recognizer {
  available(): boolean;
  requestPermissions(): Promise<{ granted: boolean }>;
  onDevice(): boolean;
  start(): void;
  abort(): void;
}

export type ListenState = "idle" | "listening" | "denied" | "unavailable";

export class Listener {
  private generation = 0;
  private wanted = false;
  /** Waiting on the permission prompts. */
  private asking = false;
  /** The recognizer was started and hasn't ended or been stopped. */
  private running = false;

  constructor(
    private rec: Recognizer,
    private onState: (s: ListenState) => void,
    private log: (msg: string) => void = () => {},
  ) {}

  async start(): Promise<void> {
    this.wanted = true;
    if (this.running || this.asking) return;
    const generation = ++this.generation;
    if (!this.rec.available()) {
      this.onState("unavailable");
      return;
    }
    this.asking = true;
    let granted = false;
    try {
      granted = (await this.rec.requestPermissions()).granted;
    } catch {
      granted = false;
    }
    // A stop, or a newer start, came in while the prompts were up.
    if (generation !== this.generation) return;
    this.asking = false;
    if (!this.wanted) return;
    if (!granted) {
      this.onState("denied");
      return;
    }
    if (!this.rec.onDevice()) {
      // The design promises dictation stays on the phone; without an on-device model, don't send audio away.
      this.onState("unavailable");
      return;
    }
    this.log("starting the recognizer");
    this.running = true;
    this.rec.start();
  }

  stop(): void {
    this.wanted = false;
    this.generation++;
    this.asking = false;
    if (!this.running) return;
    this.running = false;
    this.rec.abort();
  }

  /** The recognizer ended by itself (an error, the audio session taken): a start may run again. */
  ended(): void {
    this.running = false;
  }

  /**
   * The app is in front again, as it is once the permission prompts close: if
   * listening is wanted and isn't happening (a recognizer started behind a
   * prompt can end at once, its audio session refused), start again. A
   * request still waiting on a prompt carries on by itself.
   */
  resumed(): Promise<void> | undefined {
    if (!this.wanted || this.running || this.asking) return;
    return this.start();
  }
}
