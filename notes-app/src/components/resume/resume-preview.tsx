/**
 * The compiled resume, page by page, on native.
 *
 * Nothing here draws a PDF — this platform can't, and a real viewer is a native
 * module, which would mean a store build rather than an over-the-air update. So
 * the server draws it: `POST /latex/compile` returns one PNG per page alongside
 * the PDF, and this shows those.
 *
 * The framing deliberately matches `resume-preview.web.tsx` — a white sheet on
 * the app background with the page number beneath — because a page break is the
 * thing you preview a resume to see, and the two platforms should agree about
 * where they fall.
 *
 * Pages arrive as files rather than as bytes: they're written to the cache by
 * `lib/latex/page-cache.ts` and handed here as `file://` URIs, so decoding
 * happens natively and the image loader can hold them. A base64 data URI of a
 * full-page PNG is a megabyte-ish string to push across the bridge on every
 * render.
 */
import { Image } from 'expo-image';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { hexToRgba, Spacing } from '@/constants/theme';
import {
  LETTER_ASPECT,
  MAX_PREVIEW_PAGE_WIDTH,
  type PreviewPage,
} from '@/lib/latex/types';

// Both halves take the same props so the screen has one call site: web draws
// `pdf` and ignores `pages`, native does the reverse.
export function ResumePreview({ pages }: { pdf: Uint8Array; pages: PreviewPage[] }) {
  const [available, setAvailable] = useState(0);
  const width = Math.min(available, MAX_PREVIEW_PAGE_WIDTH);

  return (
    <View
      style={styles.container}
      onLayout={(e) => setAvailable(e.nativeEvent.layout.width)}>
      {width > 0
        ? pages.map((page, i) => (
            <PageSheet
              key={page.uri}
              page={page}
              width={width}
              pageNumber={i + 1}
              total={pages.length}
            />
          ))
        : null}
    </View>
  );
}

function PageSheet({
  page,
  width,
  pageNumber,
  total,
}: {
  page: PreviewPage;
  width: number;
  pageNumber: number;
  total: number;
}) {
  // From the rendered pixels, so the sheet is the right shape before the image
  // decodes and the list doesn't reflow under a scroll already in progress.
  // A page whose dimensions didn't come through falls back to Letter rather
  // than to zero, which would collapse the sheet to a line.
  const aspect = page.width > 0 && page.height > 0 ? page.height / page.width : LETTER_ASPECT;

  return (
    <View style={styles.pageBlock}>
      <View style={[styles.sheet, { width, height: width * aspect }]}>
        <Image
          source={{ uri: page.uri }}
          style={styles.page}
          // The sheet is already exactly the page's aspect ratio, so this only
          // decides what happens to a rounding difference — `contain` letterboxes
          // it against the white sheet instead of cropping the edge of the text.
          contentFit="contain"
          // These are local files that only change when the resume recompiles,
          // and the cache key already encodes the source and the width.
          cachePolicy="memory-disk"
          // The pages of one document are visually near-identical, so a
          // cross-fade between them reads as a flicker rather than as loading.
          transition={0}
          accessibilityLabel={`Page ${pageNumber} of ${total}`}
        />
      </View>
      <ThemedText type="small" themeColor="textSecondary" style={styles.pageLabel}>
        Page {pageNumber} of {total}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    gap: Spacing.four,
  },
  pageBlock: {
    alignItems: 'center',
    gap: Spacing.one,
  },
  // A sheet of paper: white regardless of theme, because that's what prints.
  // Same treatment as the web preview, including the border — the light theme's
  // background is also #ffffff, so a shadow alone leaves the page with no edge.
  sheet: {
    backgroundColor: '#ffffff',
    borderRadius: Spacing.three,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: hexToRgba('#000000', 0.12),
    overflow: 'hidden',
    shadowColor: '#000000',
    shadowOpacity: 0.18,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
    // Android draws none of the above — `elevation` is the only shadow it reads,
    // and this file (no platform suffix) is the one that runs there. Paired with
    // the same geometry the app's other floating surfaces use.
    elevation: 24,
  },
  page: {
    width: '100%',
    height: '100%',
  },
  pageLabel: {
    marginTop: Spacing.half,
  },
});
