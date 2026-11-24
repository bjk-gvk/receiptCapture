// Live speech-to-text using the browser's Web Speech API (webkitSpeechRecognition
// in Safari). Text accumulates across automatic restarts until reset().

const SR = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);

export class Dictation {
  /**
   * @param {(text: string) => void} onText  called whenever the transcript changes
   * @param {(state: 'off'|'listening'|'unsupported'|'blocked'|'error', detail?: string) => void} onState
   */
  constructor(onText, onState) {
    this.onText = onText;
    this.onState = onState;
    this.supported = Boolean(SR);
    this.base = ''; // text from finished recognition sessions (and manual edits)
    this.session = ''; // text from the running session
    this.active = false;
    this.rec = null;
    this.gen = 0; // ignores events from aborted instances
    this.restarts = [];
  }

  get text() {
    return join(this.base, this.session);
  }

  /** Replace the transcript (e.g. after the user edited it by hand). */
  setText(t) {
    this.base = t || '';
    this.session = '';
  }

  reset() {
    this.setText('');
    this.onText('');
  }

  start() {
    if (!this.supported || this.active) return;
    this.active = true;
    this.restarts = [];
    this._spawn();
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.gen++;
    this._fold();
    try {
      this.rec && this.rec.abort();
    } catch {}
    this.rec = null;
    this.onState('off');
  }

  _fold() {
    this.base = join(this.base, this.session);
    this.session = '';
  }

  _spawn() {
    const gen = ++this.gen;
    const rec = new SR();
    rec.lang = navigator.language || 'en-AU';
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onstart = () => gen === this.gen && this.onState('listening');
    rec.onresult = (e) => {
      if (gen !== this.gen) return;
      let s = '';
      for (let i = 0; i < e.results.length; i++) s = join(s, e.results[i][0].transcript);
      this.session = s;
      this.onText(this.text);
    };
    rec.onerror = (e) => {
      if (gen !== this.gen) return;
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.active = false;
        this.onState('blocked');
      } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
        this.onState('error', e.error);
      }
    };
    rec.onend = () => {
      if (gen !== this.gen) return;
      this._fold();
      if (!this.active) return;
      // Recognition ends by itself after silence or a time limit: restart it,
      // unless it is failing in a tight loop.
      const now = Date.now();
      this.restarts = this.restarts.filter((t) => now - t < 5000).concat(now);
      if (this.restarts.length > 4) {
        this.active = false;
        this.onState('error', 'stopped repeatedly');
        return;
      }
      this._spawn();
    };

    this.rec = rec;
    try {
      rec.start();
    } catch (err) {
      this.active = false;
      this.onState('error', err && err.message);
    }
  }
}

function join(a, b) {
  a = (a || '').trim();
  b = (b || '').trim();
  return a && b ? `${a} ${b}` : a || b;
}
