/**
 * The spreadsheet grid for a finance note.
 *
 * Cells are a fixed size, which is what makes drag-selection tractable: a touch
 * position maps straight to a row/column by division, with no per-cell layout
 * measurement and no ref-per-cell bookkeeping. The content view is measured once
 * when a drag begins — scrolling is disabled for the duration, so that origin
 * stays valid until release.
 *
 * Only the focused cell mounts a text input. Everything else renders as styled
 * text, because a real editor per cell would put hundreds of native views on
 * screen at once.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

import { Italic, Spacing, hexToRgba } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { columnLabel, cellKey, type CellValue } from '@/lib/finance/formula';
import {
  MAX_COLS,
  MAX_ROWS,
  cellPlainText,
  evaluateSheet,
  formatValue,
  getCell,
  normalizeSelection,
  readableTextColor,
  resizeSheet,
  setCellRaw,
  type Selection,
  type Sheet,
} from '@/lib/finance/sheet';

/**
 * Ring around the cell being typed into. The same blue the app already uses for
 * links, and fixed rather than theme-derived — it has to stay recognisably
 * "active" against any cell highlight the user has applied underneath it.
 */
const ACTIVE_EDGE = '#3c87f7';

const COL_W = 108;
const ROW_H = 40;
const GUTTER_W = 44;
const HEADER_H = 32;

/**
 * How long a touch must be held before it selects a range instead of scrolling.
 * Below the pan gesture; above it the ScrollView keeps the drag, which is what
 * makes "hold to select, swipe to move around" two separate gestures rather
 * than one ambiguous one.
 */
const LONG_PRESS_MS = 220;

type Props = {
  sheet: Sheet;
  /**
   * Applies a transform to the newest sheet. An updater rather than a value
   * because edits and toolbar styling land in the same interaction — see
   * `commitEdit`.
   */
  onChange: (update: (current: Sheet) => Sheet) => void;
  selection: Selection | null;
  onSelectionChange: (next: Selection | null) => void;
};

export function FinanceGrid({ sheet, onChange, selection, onSelectionChange }: Props) {
  const colors = useTheme();
  const [editing, setEditing] = useState<{ row: number; col: number } | null>(null);
  const [draft, setDraft] = useState('');
  const [dragging, setDragging] = useState(false);
  /**
   * The measured cell size, mirrored into state because the selection overlay
   * is *positioned* by it and so has to re-render when it changes. The ref
   * stays as well: the gesture reads it synchronously.
   */
  const [metrics, setMetrics] = useState({ colW: COL_W, rowH: ROW_H });

  // Read inside the gesture handlers, which are created once and would
  // otherwise close over stale state.
  /** The web drag's anchor cell; the native gesture derives its own. */
  const anchorRef = useRef<{ row: number; col: number } | null>(null);
  /** Set once a press turned into a drag, so its release doesn't also edit. */
  const draggedRef = useRef(false);
  /** Mirrors `editing` for the capture check, which runs outside render. */
  const editingRef = useRef<{ row: number; col: number } | null>(null);
  const originRef = useRef({ x: 0, y: 0 });
  const contentRef = useRef<View | null>(null);

  /** Mirrors `draft`, for the same reason `editingRef` mirrors `editing`. */
  const draftRef = useRef('');

  /** Keeps `editingRef` in step with the state it mirrors. */
  const setEditingCell = useCallback((next: { row: number; col: number } | null) => {
    editingRef.current = next;
    setEditing(next);
  }, []);

  /** Keeps `draftRef` in step with the state it mirrors. */
  const setDraftText = useCallback((next: string) => {
    draftRef.current = next;
    setDraft(next);
  }, []);

  /** Flags the in-flight press as a drag, so its release won't open a cell. */
  const markDragged = useCallback(() => {
    draggedRef.current = true;
  }, []);

  /**
   * The cell the drag last reported. A pan delivers events continuously, but
   * the selection only changes when the finger crosses into another cell —
   * without this every frame re-rendered the whole grid to produce an identical
   * selection.
   */
  const lastFocusRef = useRef<{ row: number; col: number } | null>(null);

  const computed = useMemo(() => evaluateSheet(sheet), [sheet]);

  // One faded row and column past the end, so the sheet can be extended by
  // typing at its edge rather than hunting for an "add row" control. Suppressed
  // once the grid hits its size ceiling, where the extension would be refused.
  const colCount = sheet.cols + (sheet.cols < MAX_COLS ? 1 : 0);
  const rowCount = sheet.rows + (sheet.rows < MAX_ROWS ? 1 : 0);

  /**
   * The *rendered* size of a cell, which is what pointer positions have to be
   * divided by. Not the `COL_W`/`ROW_H` constants: a cell also carries hairline
   * gridlines, and any difference between the nominal and actual size compounds
   * across the grid, so the mapped cell drifts further from the pointer the
   * further across you go. Derived from the content box instead, which is exact
   * whatever the border model turns out to be.
   */
  const metricsRef = useRef({ colW: COL_W, rowH: ROW_H });

  /**
   * Writes the open cell back.
   *
   * Built from whatever the sheet is *when this runs*, not from the copy this
   * render closed over. A toolbar tap applies its style and blurs the cell in
   * the same interaction, and the order isn't ours to choose: committing
   * against the render-time sheet meant whichever landed second wrote the other
   * one out — a colour applied to a cell being typed into would vanish on
   * commit.
   */
  const commitEdit = useCallback(() => {
    // Read from the refs, not the render's state. Tapping a second cell blurs
    // the first, and the two events don't arrive in a fixed order: if the tap
    // landed first, this ran with a `draft`/`editing` pair from a render where
    // the *new* cell was already open, so the text typed into the old one was
    // dropped without ever being written. The refs are always the live pair.
    const open = editingRef.current;
    if (!open) return;
    const { row, col } = open;
    const text = draftRef.current;
    onChange((current) => {
      if (text === (getCell(current, row, col)?.raw ?? '')) return current;
      let next = current;
      // Committing text into the trailing ghost row/column is what actually
      // grows the sheet — tapping one and leaving it blank must not, or merely
      // looking at the edge of the grid would extend it.
      if (text.trim() !== '' && (row >= current.rows || col >= current.cols)) {
        next = resizeSheet(next, Math.max(current.rows, row + 1), Math.max(current.cols, col + 1));
      }
      return setCellRaw(next, row, col, text);
    });
    setEditingCell(null);
  }, [onChange, setEditingCell]);

  /**
   * A tap both selects and starts typing. Requiring a second tap to edit is the
   * kind of friction that makes a grid feel wrong — every other spreadsheet
   * puts you straight into the cell.
   */
  const selectCell = useCallback(
    (row: number, col: number) => {
      // Flush whatever cell was open before switching, rather than trusting its
      // blur to arrive first. A late blur then finds this cell open with its own
      // text as the draft, so it commits nothing.
      commitEdit();
      anchorRef.current = { row, col };
      onSelectionChange({ r0: row, c0: col, r1: row, c1: col });
      setDraftText(getCell(sheet, row, col)?.raw ?? '');
      setEditingCell({ row, col });
    },
    [commitEdit, onSelectionChange, sheet, setDraftText, setEditingCell],
  );

  /**
   * Maps a position *within the content box* to a cell, clamped to the grid.
   * The pan gesture reports coordinates in exactly this space, so it needs no
   * window origin and can't be thrown off by scrolling.
   */
  const cellAtLocal = useCallback(
    (x: number, y: number) => {
      const { colW, rowH } = metricsRef.current;
      return {
        row: Math.max(0, Math.min(sheet.rows - 1, Math.floor(y / rowH))),
        col: Math.max(0, Math.min(sheet.cols - 1, Math.floor(x / colW))),
      };
    },
    [sheet.rows, sheet.cols],
  );

  /**
   * The same mapping for absolute pointer positions, which is what the web
   * responder events carry — hence the measured origin.
   */
  const cellAt = useCallback(
    (pageX: number, pageY: number) =>
      cellAtLocal(pageX - originRef.current.x, pageY - originRef.current.y),
    [cellAtLocal],
  );

  /**
   * Records the grid's on-screen origin, which `cellAt` maps touches against.
   *
   * Measured on press-in rather than when a drag actually starts. `measureInWindow`
   * is asynchronous, and arming the drag from inside its callback meant a quick
   * press-and-move could begin before the result landed — the responder check
   * would still read "not dragging" and the whole gesture was dropped. That race
   * is why range-selection worked only sometimes.
   */
  const measureOrigin = useCallback(() => {
    contentRef.current?.measureInWindow((x, y) => {
      originRef.current = { x, y };
    });
  }, []);

  /**
   * Freezing the row numbers.
   *
   * The gutter keeps its place in the layout — first child of the body row, so
   * every measurement below still maps a pointer onto a cell the same way — and
   * is simply pushed back by however far the grid has scrolled, which parks it
   * against the viewport's left edge. Lifting it out into its own scroller
   * instead would have meant two vertical scrollers kept in sync, and a second
   * coordinate space for the drag-selection to get wrong.
   *
   * Driven natively so a scroll doesn't re-render several hundred cells per
   * frame; `scrollXRef` mirrors it for the hit-test, which runs in JS. Web has
   * no native driver, and react-native-web animates this off the JS one.
   */
  // A lazy `useState` rather than a ref: the value is read during render (it's
  // handed to a style), and the compiler's rules put ref reads out of bounds
  // there. The initializer runs once, so it's just as stable.
  const [scrollX] = useState(() => new Animated.Value(0));
  const scrollXRef = useRef(0);
  const onHorizontalScroll = useMemo(
    () =>
      Animated.event([{ nativeEvent: { contentOffset: { x: scrollX } } }], {
        useNativeDriver: Platform.OS !== 'web',
      }),
    [scrollX],
  );

  // Mirror the animated offset back into JS. Subscribing to the value rather
  // than passing an `onScroll` listener keeps the native driver in play and puts
  // the ref write where a ref write belongs — in an effect, not in render.
  useEffect(() => {
    const id = scrollX.addListener(({ value }) => {
      scrollXRef.current = value;
      // Scrolling moves the grid under the pointer, so the cached origin has to
      // follow it or every mapped cell is offset by the scroll distance.
      measureOrigin();
    });
    return () => scrollX.removeListener(id);
  }, [scrollX, measureOrigin]);
  const stickyShift = useMemo(() => ({ transform: [{ translateX: scrollX }] }), [scrollX]);

  /**
   * Records both the grid's origin and its true per-cell size. The content box
   * holds exactly `rowCount` x `colCount` cells, so dividing gives the rendered
   * cell size directly — no assumption about how borders affect layout.
   */
  const onContentLayout = useCallback(
    (evt: LayoutChangeEvent) => {
      const { width, height } = evt.nativeEvent.layout;
      const colW = colCount > 0 && width > 0 ? width / colCount : metricsRef.current.colW;
      const rowH = rowCount > 0 && height > 0 ? height / rowCount : metricsRef.current.rowH;
      metricsRef.current = { colW, rowH };
      // Returning the previous object when nothing moved keeps this from
      // re-rendering into another layout pass.
      setMetrics((prev) => (prev.colW === colW && prev.rowH === rowH ? prev : { colW, rowH }));
      measureOrigin();
    },
    [colCount, rowCount, measureOrigin],
  );

  const onCellPressIn = useCallback(() => {
    draggedRef.current = false;
    // A new press always begins a new gesture. Clearing the anchor here means
    // one left over from a previous drag — a pointer released outside the grid
    // never delivers a release event to it — can't let the next move resume
    // that drag from the stale anchor.
    anchorRef.current = null;
    measureOrigin();
  }, [measureOrigin]);

  /**
   * On web the grid container claims the gesture up front, in the capture
   * phase, before any cell's `Pressable` can become the responder.
   *
   * The previous approach let the cell take the responder on mouse-down and
   * relied on this container stealing it back once a move began. That transfer
   * is a negotiation — the current responder gets to refuse it — so whether a
   * drag started at all depended on who won, which is why range-selection kept
   * behaving differently from one attempt to the next and why a second drag
   * could still be running against the first one's anchor. Owning the gesture
   * outright removes the negotiation entirely; it also suppresses the browser's
   * native text-drag, which was the "it drags the selection" symptom.
   *
   * Touch is untouched by this: cells keep their `Pressable`, so a tap opens a
   * cell and a swipe still scrolls, with drag-select behind the long-press.
   */
  const onStartShouldSetResponderCapture = useCallback(
    (evt: GestureResponderEvent) => {
      if (Platform.OS !== 'web') return false;
      const { pageX, pageY } = evt.nativeEvent;
      // The row-number gutter shares this container; without this a click there
      // would clamp to column A and open a cell the user never aimed at. Now
      // that the gutter is frozen it also covers whichever cells have scrolled
      // under it, and those must be just as unclickable — so the band this
      // rejects grows with the scroll offset rather than staying at the
      // content's left edge, which has moved off to the left by exactly that
      // much.
      if (pageX < originRef.current.x + scrollXRef.current) return false;
      const cell = cellAt(pageX, pageY);
      const active = editingRef.current;
      // Let clicks inside the cell being edited through to its input, so the
      // caret can still be placed by clicking.
      if (active && active.row === cell.row && active.col === cell.col) return false;
      return true;
    },
    [cellAt],
  );

  /** Web only: the mouse-down, so the anchor comes from the pointer position. */
  const onResponderGrant = useCallback(
    (evt: GestureResponderEvent) => {
      const { pageX, pageY } = evt.nativeEvent;
      const anchor = cellAt(pageX, pageY);

      anchorRef.current = anchor;
      // Not yet a drag — a press that never moves is a click, and opens the cell.
      draggedRef.current = false;
      setDragging(true);
      // Starting anywhere discards the previous selection rather than extending it.
      onSelectionChange({ r0: anchor.row, c0: anchor.col, r1: anchor.row, c1: anchor.col });
    },
    [cellAt, onSelectionChange],
  );

  const onResponderMove = useCallback(
    (evt: GestureResponderEvent) => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const { pageX, pageY } = evt.nativeEvent;
      const focus = cellAt(pageX, pageY);
      // Only a move onto a *different* cell counts as a drag; a few stray pixels
      // inside one cell is still a click.
      if (focus.row !== anchor.row || focus.col !== anchor.col) {
        draggedRef.current = true;
        // A range supersedes editing a single cell — but the cell still has to
        // be written back, or starting a drag from a cell you were typing in
        // throws the text away.
        commitEdit();
      }
      onSelectionChange(normalizeSelection(anchor, focus));
    },
    [cellAt, commitEdit, onSelectionChange],
  );

  const endDrag = useCallback(() => {
    const anchor = anchorRef.current;
    setDragging(false);
    // A press that never left its cell is a click: open it for typing.
    if (anchor && !draggedRef.current) selectCell(anchor.row, anchor.col);
    draggedRef.current = false;
  }, [selectCell]);

  /**
   * Native range selection.
   *
   * Owned by gesture-handler rather than the responder system. The previous
   * version armed a drag from the cell's `onLongPress` and then expected the
   * container to take the gesture over on the next move — but the cell's
   * `Pressable` was still the responder, and handing it over is a negotiation
   * the current responder can refuse. The transfer landed once and then stopped
   * delivering, which is why a drag only ever selected the anchor and its
   * neighbour however far the finger travelled. It also left `dragging` set
   * when a hold was released without moving, permanently disabling scrolling.
   *
   * `activateAfterLongPress` is the whole gesture split: below the threshold
   * the ScrollView keeps the drag and the sheet pans, above it this activates,
   * cancels the cell's press, and selects. Coordinates arrive relative to the
   * detector's view, so unlike the responder path there is no window origin to
   * keep in step with scrolling.
   */
  const onDragStart = useCallback(
    (x: number, y: number) => {
      const anchor = cellAtLocal(x, y);
      lastFocusRef.current = anchor;
      // The release belongs to this drag, so the cell it ends on must not also
      // open for typing. Set here rather than on first movement because the
      // long press has already committed the gesture to selecting.
      markDragged();
      setDragging(true);
      // A range supersedes editing a single cell, but the open cell is written
      // back first — a drag begun from a cell you were typing in must not throw
      // the text away. No-ops when nothing is open.
      commitEdit();
      // Starting anywhere discards the previous selection rather than extending it.
      onSelectionChange({ r0: anchor.row, c0: anchor.col, r1: anchor.row, c1: anchor.col });
    },
    [cellAtLocal, commitEdit, markDragged, onSelectionChange],
  );

  /**
   * Extends the selection. The anchor is recovered from the gesture's own
   * translation rather than remembered between callbacks — `x - translationX`
   * is exactly where the finger went down, so there is no anchor state to fall
   * out of step with the drag.
   */
  const onDragMove = useCallback(
    (x: number, y: number, dx: number, dy: number) => {
      const focus = cellAtLocal(x, y);
      const last = lastFocusRef.current;
      // Same cell as the last event: the selection would be identical, and
      // re-rendering several hundred cells per frame to redraw it is what makes
      // a drag stutter.
      if (last && last.row === focus.row && last.col === focus.col) return;
      lastFocusRef.current = focus;
      onSelectionChange(normalizeSelection(cellAtLocal(x - dx, y - dy), focus));
    },
    [cellAtLocal, onSelectionChange],
  );

  /*
   * `react-hooks/refs` reads this whole builder as render code, because the
   * handlers it receives eventually reach `metricsRef` and `draggedRef`. They
   * don't run during render — nothing here fires until a touch lands — and the
   * alternatives are worse: dropping the drag flag would let a drag's release
   * also open the cell it finished on, and dropping the measured metrics
   * reintroduces the drift that made mapped cells wander from the finger.
   */
  /* eslint-disable react-hooks/refs */
  const selectGesture = useMemo(
    () =>
      Gesture.Pan()
        // The handlers touch React state, not shared values — running them on
        // the JS thread is simpler than making each one a worklet.
        .runOnJS(true)
        .activateAfterLongPress(LONG_PRESS_MS)
        // Web keeps the responder-capture path, which is tuned around mouse
        // input and has no long-press step.
        .enabled(Platform.OS !== 'web')
        .onStart((evt) => onDragStart(evt.x, evt.y))
        .onUpdate((evt) => onDragMove(evt.x, evt.y, evt.translationX, evt.translationY))
        // Finalize, not end: a cancelled gesture has to restore scrolling too,
        // or the sheet silently stops panning.
        .onFinalize(() => setDragging(false)),
    [onDragStart, onDragMove],
  );
  /* eslint-enable react-hooks/refs */

  const gridLine = hexToRgba(colors.textSecondary, 0.18);
  const selectionFill = hexToRgba(colors.text, 0.1);
  const selectionEdge = hexToRgba(colors.text, 0.45);

  /** Content-box rect covering rows `r0..r1` and columns `c0..c1`. */
  const rectFor = (r0: number, c0: number, r1: number, c1: number) => ({
    left: c0 * metrics.colW,
    top: r0 * metrics.rowH,
    width: (c1 - c0 + 1) * metrics.colW,
    height: (r1 - r0 + 1) * metrics.rowH,
  });

  /**
   * Where the selection overlay sits. Suppressed while a cell is open for
   * typing: that cell already wears the active ring, and a range only exists
   * once a drag has closed the editor.
   */
  const selectionRect =
    selection && !editing
      ? rectFor(selection.r0, selection.c0, selection.r1, selection.c1)
      : null;

  /** The ring on the cell being typed into. */
  const activeRect = editing ? rectFor(editing.row, editing.col, editing.row, editing.col) : null;

  const renderCell = (row: number, col: number) => {
    const cell = getCell(sheet, row, col);
    const style = cell?.style;
    const isEditing = editing?.row === row && editing?.col === col;
    const value: CellValue | undefined = computed.get(cellKey(row, col));
    // The trailing row/column: real enough to tap and type into, faded until
    // committing text turns it into part of the sheet.
    const ghost = row >= sheet.rows || col >= sheet.cols;

    /**
     * The cell's formatting, shared by the static text and the input that
     * replaces it while typing. The input used to carry none of this, so every
     * mark was invisible until the cell closed — and on a touch device tapping
     * a toolbar button doesn't take focus off the input, so the cell doesn't
     * close. Formatting looked like it only applied once you pressed done.
     */
    const marks = [
      {
        // A highlighted cell derives its own legible ink, since the theme's
        // text colour is near-white in dark mode and would vanish on a pale
        // swatch.
        color: style?.color ?? (style?.bg ? readableTextColor(style.bg) : colors.text),
      },
      style?.bold && styles.bold,
      style?.italic && styles.italic,
      (style?.underline || style?.strike) && {
        textDecorationLine: (style?.underline
          ? style?.strike
            ? 'underline line-through'
            : 'underline'
          : 'line-through') as 'underline' | 'line-through' | 'underline line-through',
      },
    ];

    return (
      <View
        key={`${row},${col}`}
        style={[
          styles.cell,
          { borderColor: gridLine },
          ghost && !isEditing && styles.ghost,
          !!style?.bg && { backgroundColor: style.bg },
          // Neither the selection nor the active-cell ring is drawn here — both
          // are overlays below. A cell's borders never change.
        ]}>
        {isEditing ? (
          <TextInput
            value={draft}
            onChangeText={setDraftText}
            onBlur={commitEdit}
            onSubmitEditing={commitEdit}
            autoFocus
            style={[styles.input, ...marks]}
            // A formula is easier to correct than to retype from scratch.
            selectTextOnFocus={!draft.startsWith('=')}
          />
        ) : (
          <Pressable
            onPressIn={onCellPressIn}
            onPress={() => {
              // A drag already consumed this press; releasing must not also drop
              // the user into the cell they happened to finish on.
              if (draggedRef.current) {
                draggedRef.current = false;
                return;
              }
              selectCell(row, col);
            }}
            style={styles.cellPress}>
            <Text
              numberOfLines={1}
              style={[
                styles.cellText,
                ...marks,
                { textAlign: style?.align ?? (typeof value === 'number' ? 'right' : 'left') },
                typeof value === 'object' && value !== null && styles.errorText,
              ]}>
              {/* An unevaluated cell still shows its own text (e.g. while a
                  formula it depends on is mid-edit). */}
              {value === undefined ? cellPlainText(cell) : formatValue(value)}
            </Text>
          </Pressable>
        )}
      </View>
    );
  };

  const rows = Array.from({ length: rowCount }, (_, r) => r);
  const cols = Array.from({ length: colCount }, (_, c) => c);

  return (
    <Animated.ScrollView
      horizontal
      scrollEnabled={!dragging}
      showsHorizontalScrollIndicator={false}
      onScroll={onHorizontalScroll}
      scrollEventThrottle={16}
      // Both scrollers need this, not just the inner one: either would
      // otherwise swallow the first tap while the keyboard is up to dismiss it,
      // so moving from one cell to another took two taps.
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.hScroll}>
      <View>
        {/* Column headers, pinned above the scrolling body. */}
        <View style={styles.headerRow}>
          <Animated.View
            style={[
              styles.gutterCorner,
              { borderColor: gridLine, backgroundColor: colors.background },
              stickyShift,
            ]}
          />
          {cols.map((c) => (
            <View
              key={c}
              style={[
                styles.colHeader,
                { borderColor: gridLine },
                c >= sheet.cols && styles.ghost,
              ]}>
              <Text style={[styles.headerText, { color: colors.textSecondary }]}>
                {columnLabel(c)}
              </Text>
            </View>
          ))}
        </View>

        <ScrollView
          scrollEnabled={!dragging}
          showsVerticalScrollIndicator={false}
          onScroll={measureOrigin}
          scrollEventThrottle={16}
          keyboardShouldPersistTaps="handled">
          <View
            style={styles.body}
            onStartShouldSetResponderCapture={onStartShouldSetResponderCapture}
            onStartShouldSetResponder={() => false}
            onResponderGrant={onResponderGrant}
            onResponderMove={onResponderMove}
            onResponderRelease={endDrag}
            onResponderTerminate={endDrag}>
            <Animated.View
              style={[styles.gutter, { backgroundColor: colors.background }, stickyShift]}>
              {rows.map((r) => (
                <View
                  key={r}
                  style={[
                    styles.rowHeader,
                    { borderColor: gridLine },
                    r >= sheet.rows && styles.ghost,
                  ]}>
                  <Text style={[styles.headerText, { color: colors.textSecondary }]}>{r + 1}</Text>
                </View>
              ))}
            </Animated.View>
            {/* The detector owns its own view, so the content box below keeps
                `contentRef` for measurement rather than having it cloned away.
                Both share an origin, so the gesture's local coordinates map
                straight onto the content box. */}
            <GestureDetector gesture={selectGesture}>
              <View collapsable={false}>
                {/* The origin and cell metrics have to be current at mouse-down,
                    since `cellAt` reads them synchronously while `measureInWindow`
                    is async — re-measuring on layout keeps them so. */}
                <View ref={contentRef} collapsable={false} onLayout={onContentLayout}>
                  {rows.map((r) => (
                    <View key={r} style={styles.row}>
                      {cols.map((c) => renderCell(r, c))}
                    </View>
                  ))}
                  {/* Selection and active cell are both drawn as single
                      rectangles over the grid rather than as borders on the
                      cells they cover.

                      Android does not reliably repaint a View's border when the
                      style that introduced it goes away: deselecting left the
                      old edge behind, and moving the active cell left its 2px
                      ring behind recoloured but not resized. Declaring every
                      width up front wasn't enough. Now no cell's border ever
                      changes at all, so nothing can be stranded — and dragging
                      a range moves one view instead of restyling hundreds. */}
                  {selectionRect && (
                    <View
                      pointerEvents="none"
                      style={[
                        styles.selectionOverlay,
                        selectionRect,
                        { backgroundColor: selectionFill, borderColor: selectionEdge },
                      ]}
                    />
                  )}
                  {/* Last, so the active ring reads over the selection fill. */}
                  {activeRect && <View pointerEvents="none" style={[styles.activeOverlay, activeRect]} />}
                </View>
              </View>
            </GestureDetector>
          </View>
        </ScrollView>
      </View>
    </Animated.ScrollView>
  );
}

const styles = StyleSheet.create({
  hScroll: { paddingRight: 24 },
  headerRow: { flexDirection: 'row' },
  body: { flexDirection: 'row' },
  // Both carry a zIndex and an opaque fill because they no longer merely sit
  // beside the cells — once frozen they slide over them, and a transparent
  // gutter would show column D's contents through the row numbers.
  gutter: { width: GUTTER_W, zIndex: 2 },
  gutterCorner: {
    width: GUTTER_W,
    height: HEADER_H,
    zIndex: 2,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  colHeader: {
    width: COL_W,
    height: HEADER_H,
    alignItems: 'center',
    justifyContent: 'center',
    borderRightWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowHeader: {
    width: GUTTER_W,
    height: ROW_H,
    alignItems: 'center',
    justifyContent: 'center',
    borderRightWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  // Without this a pointer drag across the grid runs the browser's own text
  // selection, painting cell contents blue instead of selecting a range.
  headerText: { fontSize: 11, fontWeight: '600', userSelect: 'none' },
  row: { flexDirection: 'row' },
  // Just the gridlines, and they never change — everything that used to mark a
  // cell's state is an overlay now.
  cell: {
    width: COL_W,
    height: ROW_H,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
  },
  /** The selection rectangle. Sits above the cells, below the active ring. */
  selectionOverlay: {
    position: 'absolute',
    borderWidth: 1.5,
    borderRadius: Spacing.one,
  },
  /**
   * The active cell's ring, the way Excel and Sheets mark it. Border only — no
   * fill, or it would hide the cell's own highlight colour.
   */
  activeOverlay: {
    position: 'absolute',
    borderWidth: 2,
    borderRadius: Spacing.one,
    borderColor: ACTIVE_EDGE,
  },
  cellPress: { flex: 1, justifyContent: 'center', paddingHorizontal: 8 },
  /** The trailing row/column, before typing turns it into part of the sheet. */
  ghost: { opacity: 0.35 },
  cellText: { fontSize: 14, userSelect: 'none' },
  bold: { fontWeight: '700' },
  italic: Italic,
  errorText: { fontWeight: '600', opacity: 0.9 },
  input: {
    flex: 1,
    paddingHorizontal: 8,
    fontSize: 14,
    // Web focus rings clash with the cell's own selection border.
    ...Platform.select({ web: { outlineStyle: 'none' as never }, default: {} }),
  },
});
