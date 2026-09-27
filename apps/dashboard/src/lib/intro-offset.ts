import { createContext } from 'react';

/** Seconds of brand intro at the start of the stream. Stored times (chapters,
 * transcript, comments) use stream time; displays subtract this so content
 * starts at 0:00. See docs/features/brand-intro-and-watermark.md. */
export const IntroOffset = createContext(0);
