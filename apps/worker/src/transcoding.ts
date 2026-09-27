import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ffprobe, runFfmpeg, type ProbeResult } from './ffmpeg.js';

export interface RenditionProfile {
  quality: string;
  width: number;
  height: number;
  bitrateKbps: number;
  profile: string;
  level: string;
  codecTag: string;
}

export const TRANSCODING_LADDER: RenditionProfile[] = [
  { quality: '360p',  width: 640,  height: 360,  bitrateKbps: 1000,  profile: 'main', level: '3.0', codecTag: 'avc1.4d401e' },
  { quality: '480p',  width: 854,  height: 480,  bitrateKbps: 1800,  profile: 'main', level: '3.0', codecTag: 'avc1.4d401e' },
  { quality: '720p',  width: 1280, height: 720,  bitrateKbps: 3000,  profile: 'main', level: '3.1', codecTag: 'avc1.4d401f' },
  { quality: '1080p', width: 1920, height: 1080, bitrateKbps: 6000,  profile: 'high', level: '4.0', codecTag: 'avc1.640028' },
  { quality: '1440p', width: 2560, height: 1440, bitrateKbps: 10000, profile: 'high', level: '5.0', codecTag: 'avc1.640032' },
  { quality: '2160p', width: 3840, height: 2160, bitrateKbps: 20000, profile: 'high', level: '5.1', codecTag: 'avc1.640033' },
  { quality: '4320p', width: 7680, height: 4320, bitrateKbps: 40000, profile: 'high', level: '6.0', codecTag: 'avc1.64003c' },
];

/**
 * Filter the transcoding ladder to only include renditions at or below the
 * source resolution. Handles portrait videos by comparing against the short
 * side. Always returns the lowest configured rendition to guarantee a
 * playable output even for very small sources.
 */
export function filterLadder(
  sourceWidth: number,
  sourceHeight: number,
  profiles: RenditionProfile[] = TRANSCODING_LADDER,
): RenditionProfile[] {
  const shortSide = Math.min(sourceWidth, sourceHeight);
  const filtered = profiles.filter(p => p.height <= shortSide);
  return filtered.length > 0 ? filtered : [profiles[0]!];
}

/** Burned into every new rendition so downloaded copies carry the brand.
 * See docs/features/brand-intro-and-watermark.md. */
export interface Branding {
  intro: { path: string; durationSec: number } | null;
  watermarkText: string | null;
  fontFile: string;
}

/** The watermark is shown for this many seconds, then hidden for the same. */
const WATERMARK_BLINK_SEC = 5;

/** Choose the intro for the source's aspect ratio, as videotocopy/prepend-intro.sh
 * does: dedicated 16:9 and 9:16 intros, square for everything else. */
export async function resolveIntro(
  introDir: string,
  width: number,
  height: number,
): Promise<{ path: string; durationSec: number }> {
  const ratio = width / height;
  const near = (target: number) => Math.abs(ratio - target) < 0.02;
  const kind = near(16 / 9) ? 'landscape' : near(9 / 16) ? 'portrait' : 'square';
  const introPath = path.join(introDir, `intro-${kind}.mp4`);
  await access(introPath).catch(() => { throw new Error(`Intro file is missing: ${introPath}`); });
  const probe = await ffprobe(introPath);
  if (probe.duration <= 0 || !probe.hasAudio) throw new Error(`Intro must have video and audio: ${introPath}`);
  return { path: introPath, durationSec: probe.duration };
}

/** Escape a filter option value twice: once for the option parser and once
 * for the filtergraph parser, so any URL or font path is taken literally. */
function escapeFilterValue(value: string): string {
  const option = value.replace(/[\\':]/g, (c) => `\\${c}`);
  return option.replace(/[\\'[\],;]/g, (c) => `\\${c}`);
}

/** Build the ffmpeg input and filter arguments for one rendition. Exported so
 * the graph can be checked without running a full transcode. */
export function buildRenditionFilter(
  sourcePath: string,
  source: ProbeResult,
  profile: RenditionProfile,
  branding: Branding,
): { inputs: string[]; filter: string; video: string; audio: string } {
  const scale = `scale=w=${profile.width}:h=${profile.height}:force_original_aspect_ratio=decrease:force_divisible_by=2`;
  const intro = branding.intro;
  const offset = intro?.durationSec ?? 0;
  const watermark = branding.watermarkText
    ? `,drawtext=fontfile=${escapeFilterValue(branding.fontFile)}:expansion=none:text=${escapeFilterValue(branding.watermarkText)}`
      + `:fontsize=h*0.045:fontcolor=white@0.7:borderw=2:bordercolor=black@0.5`
      + `:x=(w-text_w)/2:y=h*0.04`
      + `:enable='gte(t,${offset})*lt(mod(t-${offset},${WATERMARK_BLINK_SEC * 2}),${WATERMARK_BLINK_SEC})'`
    : '';

  if (!intro) {
    return { inputs: ['-i', sourcePath], filter: `[0:v]${scale}${watermark}[v]`, video: '[v]', audio: '0:a?' };
  }

  // Concat needs identical canvases: cover-crop the intro to the source frame,
  // and give silent sources an audio track so both segments have one.
  const w = Math.floor(source.width / 2) * 2;
  const h = Math.floor(source.height / 2) * 2;
  const audioFormat = 'aformat=sample_rates=48000:channel_layouts=stereo';
  const inputs = ['-i', sourcePath, '-i', intro.path];
  let sourceAudio = `[0:a]${audioFormat}[sa]`;
  if (!source.hasAudio) {
    inputs.push('-f', 'lavfi', '-t', String(source.duration), '-i', 'anullsrc=r=48000:cl=stereo');
    sourceAudio = `[2:a]${audioFormat}[sa]`;
  }
  const filter = [
    `[1:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,fps=${source.fps},format=yuv420p[iv]`,
    `[1:a]${audioFormat}[ia]`,
    `[0:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[sv]`,
    sourceAudio,
    `[iv][ia][sv][sa]concat=n=2:v=1:a=1[cv][ca]`,
    `[cv]${scale}${watermark}[v]`,
  ].join(';');
  return { inputs, filter, video: '[v]', audio: '[ca]' };
}

export async function transcodeRendition(
  sourcePath: string,
  source: ProbeResult,
  outputDir: string,
  profile: RenditionProfile,
  branding: Branding,
  threads?: number,
): Promise<void> {
  const renditionDir = path.join(outputDir, profile.quality);
  await mkdir(renditionDir, { recursive: true });

  // Dynamic timeout: 4x video duration (minimum 5 min)
  const timeoutMs = source.duration
    ? Math.max(5 * 60_000, source.duration * 4_000)
    : undefined;

  const graph = buildRenditionFilter(sourcePath, source, profile, branding);
  // Keyframes every 2s; with an intro, also exactly where the content starts
  // so players can skip the intro without decoding from an earlier frame.
  const offset = branding.intro?.durationSec ?? 0;
  const keyframes = offset > 0
    ? `expr:if(eq(n_forced,0),1,gte(t,${offset}+(n_forced-1)*2))`
    : 'expr:gte(t,n_forced*2)';

  await runFfmpeg([
    '-y',
    ...(threads ? ['-threads', String(threads)] : []),
    ...graph.inputs,
    '-filter_complex', graph.filter,
    '-map', graph.video,
    '-map', graph.audio,
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '23',
    '-maxrate', `${profile.bitrateKbps}k`,
    '-bufsize', `${profile.bitrateKbps * 2}k`,
    '-profile:v', profile.profile,
    '-level', profile.level,
    '-force_key_frames', keyframes,
    '-c:a', 'aac',
    '-b:a', '128k',
    '-f', 'hls',
    '-hls_time', '6',
    '-hls_playlist_type', 'vod',
    '-hls_segment_filename', path.join(renditionDir, 'segment_%03d.ts'),
    path.join(renditionDir, 'index.m3u8'),
  ], timeoutMs);
}

export async function extractPosterThumbnail(
  sourcePath: string,
  outputDir: string,
  durationSec: number,
): Promise<void> {
  const posterTime = Math.max(0, Math.floor(durationSec * 0.25));
  await runFfmpeg([
    '-y', '-i', sourcePath,
    '-ss', String(posterTime),
    '-vframes', '1',
    '-vf', 'scale=640:-2',
    '-q:v', '2',
    path.join(outputDir, 'thumbnail.jpg'),
  ]);
}

export async function createDownloadableMp4(
  outputDir: string,
  profile: RenditionProfile,
): Promise<void> {
  const renditionDir = path.join(outputDir, profile.quality);
  const playlistPath = path.join(renditionDir, 'index.m3u8');

  // Fast remux: copies already-encoded streams into MP4 container (no re-encoding)
  await runFfmpeg([
    '-y',
    '-i', playlistPath,
    '-c', 'copy',
    '-movflags', '+faststart',
    path.join(renditionDir, 'download.mp4'),
  ]);
}

/** A rendition as it was actually encoded. The ladder profile only bounds the
 * output: `force_original_aspect_ratio=decrease` fits the source inside that
 * box, so a 9:16 source at the 854x480 rung really comes out 270x480. */
export interface EncodedRendition {
  profile: RenditionProfile;
  width: number;
  height: number;
}

export async function createMasterPlaylist(
  outputDir: string,
  renditions: EncodedRendition[],
): Promise<void> {
  let content = '#EXTM3U\n#EXT-X-VERSION:3\n';
  for (const { profile, width, height } of renditions) {
    content += `#EXT-X-STREAM-INF:BANDWIDTH=${profile.bitrateKbps * 1000},RESOLUTION=${width}x${height},CODECS="${profile.codecTag},mp4a.40.2"\n`;
    content += `${profile.quality}/index.m3u8\n`;
  }
  await writeFile(path.join(outputDir, 'master.m3u8'), content, 'utf-8');
}
