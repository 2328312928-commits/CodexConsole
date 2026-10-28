import readline from 'node:readline';

export class Aborted extends Error {}

/** Line prompts that work in a terminal (with hidden password input) and with piped stdin. */
export class Prompter {
  private readonly piped: readline.Interface | null = null;
  private readonly buffered: string[] = [];
  private readonly waiters: Array<(line: string | null) => void> = [];
  private ended = false;

  constructor() {
    if (!process.stdin.isTTY) {
      this.piped = readline.createInterface({ input: process.stdin, terminal: false });
      this.piped.on('line', (line) => {
        const w = this.waiters.shift();
        if (w) w(line);
        else this.buffered.push(line);
      });
      this.piped.on('close', () => {
        this.ended = true;
        for (const w of this.waiters.splice(0)) w(null);
      });
    }
  }

  async ask(question: string): Promise<string> {
    if (!this.piped) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      return new Promise((resolve, reject) => {
        rl.on('SIGINT', () => {
          rl.close();
          reject(new Aborted());
        });
        rl.question(question, (answer) => {
          rl.close();
          resolve(answer);
        });
      });
    }
    process.stdout.write(question);
    const line =
      this.buffered.length > 0 ? this.buffered.shift()! : this.ended ? null : await new Promise<string | null>((r) => this.waiters.push(r));
    process.stdout.write('\n');
    if (line === null) throw new Aborted();
    return line;
  }

  /** Like ask(), but nothing is echoed while typing. */
  askHidden(question: string): Promise<string> {
    if (this.piped) return this.ask(question);
    const stdin = process.stdin;
    return new Promise((resolve, reject) => {
      process.stdout.write(question);
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding('utf8');
      let value = '';
      const finish = (err?: Error) => {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        if (err) reject(err);
        else resolve(value);
      };
      const onData = (chunk: string) => {
        if (chunk.startsWith('\u001b')) return; // arrow keys and other escape sequences
        for (const ch of chunk) {
          if (ch === '\r' || ch === '\n') return finish();
          if (ch === '\u0003' || ch === '\u0004') return finish(new Aborted());
          if (ch === '\u007f' || ch === '\b') value = Array.from(value).slice(0, -1).join('');
          else if (ch >= ' ') value += ch;
        }
      };
      stdin.on('data', onData);
    });
  }

  close(): void {
    this.piped?.close();
  }
}
