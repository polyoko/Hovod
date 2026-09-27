import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour default

export async function runFfmpeg(args: string[], timeoutMs?: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'inherit', 'inherit'] });
    let killed = false;

    const timeout = setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');
      // Force kill after 5s if SIGTERM doesn't work
      setTimeout(() => proc.kill('SIGKILL'), 5000);
      reject(new Error('FFmpeg process timed out'));
    }, timeoutMs ?? DEFAULT_TIMEOUT_MS);

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to start FFmpeg: ${err.message}`));
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (killed) return; // Already rejected by timeout
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg exited with code ${code}`));
    });
  });
}

export interface ProbeResult {
  width: number;
  height: number;
  duration: number;
  /** Average frame rate of the first video stream, or 30 when unknown. */
  fps: number;
  hasAudio: boolean;
}

export async function ffprobe(filePath: string): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,width,height,duration,avg_frame_rate:stream_side_data=rotation:stream_tags=rotate',
      '-show_entries', 'format=duration',
      '-of', 'json',
      filePath,
    ]);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    proc.on('error', (err) => {
      reject(new Error(`Failed to start ffprobe: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`ffprobe exited with code ${code}`));
      }
      try {
        const data = JSON.parse(stdout);
        const streams: Array<Record<string, unknown>> = data.streams ?? [];
        const stream = streams.find((s) => s.codec_type === 'video') ?? {};
        const duration = parseFloat(String(stream.duration || data.format?.duration || '0'));
        const [num, den] = String(stream.avg_frame_rate ?? '0/0').split('/').map(Number);
        const fps = num && den ? num / den : 30;
        // Phone clips are often coded landscape with a 90° display rotation;
        // ffmpeg autorotates on decode, so report the displayed size.
        const sideData = (stream.side_data_list as Array<{ rotation?: number }> | undefined) ?? [];
        const rotation = Number(sideData.find((d) => d.rotation !== undefined)?.rotation
          ?? (stream.tags as { rotate?: string } | undefined)?.rotate ?? 0);
        const swap = Math.abs(rotation) % 180 === 90;
        const codedWidth = Number(stream.width) || 0;
        const codedHeight = Number(stream.height) || 0;
        resolve({
          width: swap ? codedHeight : codedWidth,
          height: swap ? codedWidth : codedHeight,
          duration,
          fps,
          hasAudio: streams.some((s) => s.codec_type === 'audio'),
        });
      } catch {
        reject(new Error('Failed to parse ffprobe output'));
      }
    });
  });
}
