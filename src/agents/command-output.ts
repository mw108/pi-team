import { StringDecoder } from "node:string_decoder";

const limit = 50_000;
const truncatedMarker = "[output truncated]\n";

/** Retains the useful tail without rebuilding a growing string for every chunk. */
class BoundedTail {
  private chunks: string[] = [];
  private head = 0;
  private length = 0;
  private truncated = false;

  append(text: string) {
    if (!text) return;
    if (text.length >= limit) {
      const hadContent = this.length > 0;
      this.truncated ||= text.length > limit || hadContent;
      const capacity = this.truncated ? limit - truncatedMarker.length : limit;
      this.chunks = [text.slice(-capacity)];
      this.head = 0;
      this.length = capacity;
    } else {
      this.chunks.push(text);
      this.length += text.length;
      if (this.length > limit) this.truncated = true;
      const capacity = this.truncated ? limit - truncatedMarker.length : limit;
      while (this.length > capacity) {
        const first = this.chunks[this.head];
        const excess = this.length - capacity;
        if (first.length <= excess) {
          this.length -= first.length;
          this.head++;
        } else {
          this.chunks[this.head] = first.slice(excess);
          this.length -= excess;
        }
        this.truncated = true;
      }
      if (this.head > 1024) {
        this.chunks = this.chunks.slice(this.head);
        this.head = 0;
      }
    }
    // A UTF-16 slice may begin between an emoji's surrogate halves.
    const first = this.chunks[this.head];
    if (this.truncated && first && /^[\uDC00-\uDFFF]/.test(first)) {
      this.chunks[this.head] = first.slice(1);
      this.length--;
    }
  }

  value() {
    return (
      (this.truncated ? truncatedMarker : "") +
      this.chunks.slice(this.head).join("")
    );
  }
}

export class CommandOutputCollector {
  private stdoutDecoder = new StringDecoder("utf8");
  private stderrDecoder = new StringDecoder("utf8");
  private combined = new BoundedTail();
  private standard = new BoundedTail();
  private error = new BoundedTail();

  write(stream: "stdout" | "stderr", chunk: Buffer) {
    const text =
      stream === "stdout"
        ? this.stdoutDecoder.write(chunk)
        : this.stderrDecoder.write(chunk);
    this.append(stream, text);
  }

  private append(stream: "stdout" | "stderr", text: string) {
    (stream === "stdout" ? this.standard : this.error).append(text);
    this.combined.append(text);
  }

  timeout() {
    this.combined.append("\nCommand timeout");
  }

  finish() {
    this.append("stdout", this.stdoutDecoder.end());
    this.append("stderr", this.stderrDecoder.end());
    return {
      output: this.combined.value(),
      stdout: this.standard.value(),
      stderr: this.error.value(),
    };
  }
}
