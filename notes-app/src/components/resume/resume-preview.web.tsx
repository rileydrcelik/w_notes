/**
 * The compiled resume, page by page.
 *
 * Each PDF page is painted to its own canvas and framed as a white sheet on the
 * app background, so the page breaks are literal — you see where page one ends
 * and page two begins, which is the whole reason a resume gets previewed at all.
 */
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { hexToRgba, Spacing } from '@/constants/theme';
import { loadPdf } from '@/lib/latex/pdf-render';
import type { PdfDocument } from '@/lib/latex/types';

/** Widest a page is drawn, so a big window doesn't render a wall-sized sheet. */
const MAX_PAGE_WIDTH = 720;

export function ResumePreview({ pdf }: { pdf: Uint8Array }) {
  const [doc, setDoc] = useState<PdfDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let opened: PdfDocument | null = null;

    loadPdf(pdf)
      .then((next) => {
        if (cancelled) {
          next.destroy();
          return;
        }
        opened = next;
        setDoc(next);
        // Cleared here rather than up front: a synchronous reset in the effect
        // body would re-render before the document is even open.
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        console.warn('[resume-preview] failed to open pdf:', e);
        setError('The compiled PDF could not be opened.');
      });

    return () => {
      cancelled = true;
      // Drop the previous document as soon as new bytes arrive; pdf.js holds a
      // worker and a decoded page cache per document.
      opened?.destroy();
      setDoc(null);
    };
  }, [pdf]);

  const pageWidth = Math.min(width, MAX_PAGE_WIDTH);

  return (
    <View style={styles.container} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      {error ? (
        <ThemedText type="small" themeColor="textSecondary">
          {error}
        </ThemedText>
      ) : null}
      {doc && pageWidth > 0
        ? Array.from({ length: doc.pageCount }, (_, i) => (
            <PdfPage key={i + 1} doc={doc} pageNumber={i + 1} width={pageWidth} total={doc.pageCount} />
          ))
        : null}
    </View>
  );
}

function PdfPage({
  doc,
  pageNumber,
  width,
  total,
}: {
  doc: PdfDocument;
  pageNumber: number;
  width: number;
  total: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Reserve the page's real height before it paints, so the scroll position
  // doesn't jump around as pages render in.
  const [height, setHeight] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    void doc.pageSize(pageNumber).then((size) => {
      if (!cancelled) setHeight((width / size.width) * size.height);
    });

    const canvas = canvasRef.current;
    if (canvas) {
      doc.renderPage(pageNumber, canvas, width).catch((e: unknown) => {
        // A render cancelled by unmount or by new bytes is expected; a real
        // failure leaves the sheet blank rather than taking the screen down.
        if (!cancelled) console.warn(`[resume-preview] page ${pageNumber} failed to render:`, e);
      });
    }

    return () => {
      cancelled = true;
    };
  }, [doc, pageNumber, width]);

  return (
    <View style={styles.pageBlock}>
      <View style={[styles.sheet, { width, height: height ?? width * 1.294 }]}>
        <canvas ref={canvasRef} style={{ display: 'block', borderRadius: Spacing.three }} />
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
  // It needs a border of its own — the default light theme's background is also
  // #ffffff, so a shadow alone leaves the page with no visible edge.
  sheet: {
    backgroundColor: '#ffffff',
    borderRadius: Spacing.three,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: hexToRgba('#000000', 0.12),
    overflow: 'hidden',
    // Lifts the page off the background the way the app's cards do.
    shadowColor: '#000000',
    shadowOpacity: 0.18,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
  },
  pageLabel: {
    marginTop: Spacing.half,
  },
});
