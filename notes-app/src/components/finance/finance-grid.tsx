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
import { useCallback, useMemo, useRef, useState } from 'react';
import {
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

import { hexToRgba } from '@/constants/theme';
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
  selectionContains,
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

type Props = {
  sheet: Sheet;
  onChange: (next: Sheet) => void;
  selection: Selection | null;
  onSelectionChange: (next: Selection | null) => void;
};

export function FinanceGrid({ sheet, onChange, selection, onSelectionChange }: Props) {
  const colors = useTheme();
  const [editing, setEditing] = useState<{ row: number; col: number } | null>(null);
  const [draft, setDraft] = useState('');
  const [dragging, setDragging] = useState(false);

  // Read inside the gesture handlers, which are created once and would
  // otherwise close over stale state.
  const anchorRef = useRef<{ row: number; col: number } | null>(null);
  const draggingRef = useRef(false);
  /** The cell a press started on, before it's known to be a tap or a drag. */
  const pressAnchorRef = useRef<{ row: number; col: number } | null>(null);
  /** Set once a press turned into a drag, so its release doesn't also edit. */
  const draggedRef = useRef(false);
  /** Mirrors `editing` for the capture check, which runs outside render. */
  const editingRef = useRef<{ row: number; col: number } | null>(null);
  const originRef = useRef({ x: 0, y: 0 });
  const contentRef = useRef<View | null>(null);

  /** Keeps `editingRef` in step with the state it mirrors. */
  const setEditingCell = useCallback((next: { row: number; col: number } | null) => {
    editingRef.current = next;
    setEditing(next);
  }, []);

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

  const commitEdit = useCallback(() => {
    if (!editing) return;
    const { row, col } = editing;
    const existing = getCell(sheet, row, col)?.raw ?? '';
    if (draft !== existing) {
      let next = sheet;
      // Committing text into the trailing ghost row/column is what actually
      // grows the sheet — tapping one and leaving it blank must not, or merely
      // looking at the edge of the grid would extend it.
      if (draft.trim() !== '' && (row >= sheet.rows || col >= sheet.cols)) {
        next = resizeSheet(next, Math.max(sheet.rows, row + 1), Math.max(sheet.cols, col + 1));
      }
      onChange(setCellRaw(next, row, col, draft));
    }
    setEditingCell(null);
  }, [editing, draft, sheet, onChange, setEditingCell]);

  /**
   * A tap both selects and starts typing. Requiring a second tap to edit is the
   * kind of friction that makes a grid feel wrong — every other spreadsheet
   * puts you straight into the cell.
   */
  const selectCell = useCallback(
    (row: number, col: number) => {
      anchorRef.current = { row, col };
      onSelectionChange({ r0: row, c0: col, r1: row, c1: col });
      setDraft(getCell(sheet, row, col)?.raw ?? '');
      setEditingCell({ row, col });
    },
    [onSelectionChange, sheet, setEditingCell],
  );

  /** Maps an absolute pointer position to a cell, clamped to the grid. */
  const cellAt = useCallback(
    (pageX: number, pageY: number) => {
      const { colW, rowH } = metricsRef.current;
      const col = Math.floor((pageX - originRef.current.x) / colW);
      const row = Math.floor((pageY - originRef.current.y) / rowH);
      return {
        row: Math.max(0, Math.min(sheet.rows - 1, row)),
        col: Math.max(0, Math.min(sheet.cols - 1, col)),
      };
    },
    [sheet.rows, sheet.cols],
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
   * Records both the grid's origin and its true per-cell size. The content box
   * holds exactly `rowCount` x `colCount` cells, so dividing gives the rendered
   * cell size directly — no assumption about how borders affect layout.
   */
  const onContentLayout = useCallback(
    (evt: LayoutChangeEvent) => {
      const { width, height } = evt.nativeEvent.layout;
      if (colCount > 0 && width > 0) metricsRef.current.colW = width / colCount;
      if (rowCount > 0 && height > 0) metricsRef.current.rowH = height / rowCount;
      measureOrigin();
    },
    [colCount, rowCount, measureOrigin],
  );

  const onCellPressIn = useCallback(
    (row: number, col: number) => {
      pressAnchorRef.current = { row, col };
      draggedRef.current = false;
      // A new press always begins a new gesture. Clearing these here means a
      // drag flag left set by a previous one — a pointer released outside the
      // grid never delivers a release event to it — can't let the next move
      // resume the old drag from the old anchor.
      draggingRef.current = false;
      anchorRef.current = null;
      measureOrigin();
    },
    [measureOrigin],
  );

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
      // would clamp to column A and open a cell the user never aimed at.
      if (pageX < originRef.current.x) return false;
      const cell = cellAt(pageX, pageY);
      const active = editingRef.current;
      // Let clicks inside the cell being edited through to its input, so the
      // caret can still be placed by clicking.
      if (active && active.row === cell.row && active.col === cell.col) return false;
      return true;
    },
    [cellAt],
  );

  /** Native only: a move promotes the long-press into a drag. */
  const onMoveShouldSetResponder = useCallback(() => draggingRef.current, []);

  /**
   * Starts a gesture. On web this is the mouse-down, so the anchor comes from
   * the pointer position; on native the long-press already set it.
   */
  const onResponderGrant = useCallback(
    (evt: GestureResponderEvent) => {
      const { pageX, pageY } = evt.nativeEvent;
      const anchor =
        Platform.OS === 'web' ? cellAt(pageX, pageY) : (pressAnchorRef.current ?? null);
      if (!anchor) return;

      anchorRef.current = anchor;
      // Not yet a drag — a press that never moves is a click, and opens the cell.
      draggedRef.current = false;
      draggingRef.current = true;
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
        // A range supersedes editing a single cell.
        if (editingRef.current) setEditingCell(null);
      }
      onSelectionChange(normalizeSelection(anchor, focus));
    },
    [cellAt, onSelectionChange, setEditingCell],
  );

  const endDrag = useCallback(() => {
    const anchor = anchorRef.current;
    draggingRef.current = false;
    pressAnchorRef.current = null;
    setDragging(false);
    // A press that never left its cell is a click: open it for typing. On native
    // the cell's own Pressable does this, so only the web path needs it here.
    if (Platform.OS === 'web' && anchor && !draggedRef.current) {
      selectCell(anchor.row, anchor.col);
    }
    draggedRef.current = false;
  }, [selectCell]);

  /** Touch long-press. Synchronous — the origin was measured back at press-in. */
  const armDrag = useCallback(
    (row: number, col: number) => {
      anchorRef.current = { row, col };
      draggingRef.current = true;
      setDragging(true);
      onSelectionChange({ r0: row, c0: col, r1: row, c1: col });
    },
    [onSelectionChange],
  );

  const gridLine = hexToRgba(colors.textSecondary, 0.18);
  const selectionFill = hexToRgba(colors.text, 0.1);
  const selectionEdge = hexToRgba(colors.text, 0.45);

  const renderCell = (row: number, col: number) => {
    const cell = getCell(sheet, row, col);
    const style = cell?.style;
    const selected = selection ? selectionContains(selection, row, col) : false;
    const isEditing = editing?.row === row && editing?.col === col;
    const value: CellValue | undefined = computed.get(cellKey(row, col));
    // The trailing row/column: real enough to tap and type into, faded until
    // committing text turns it into part of the sheet.
    const ghost = row >= sheet.rows || col >= sheet.cols;

    return (
      <View
        key={`${row},${col}`}
        style={[
          styles.cell,
          { borderColor: gridLine },
          ghost && !isEditing && styles.ghost,
          !!style?.bg && { backgroundColor: style.bg },
          selected && !isEditing && { backgroundColor: selectionFill },
          selected && { borderColor: selectionEdge },
          // Last, so it wins over the selection edge: the cell being typed into
          // gets a ring on all four sides, the way Excel and Sheets mark the
          // active cell. Border only — no fill, or it would fight the cell's own
          // highlight colour.
          isEditing && styles.editingCell,
        ]}>
        {isEditing ? (
          <TextInput
            value={draft}
            onChangeText={setDraft}
            onBlur={commitEdit}
            onSubmitEditing={commitEdit}
            autoFocus
            // Same contrast rule as the static cell — the highlight stays
            // visible behind the input while editing.
            style={[
              styles.input,
              { color: style?.bg ? readableTextColor(style.bg) : colors.text },
            ]}
            // A formula is easier to correct than to retype from scratch.
            selectTextOnFocus={!draft.startsWith('=')}
          />
        ) : (
          <Pressable
            onPressIn={() => onCellPressIn(row, col)}
            onPress={() => {
              // A drag already consumed this press; releasing must not also drop
              // the user into the cell they happened to finish on.
              if (draggedRef.current) {
                draggedRef.current = false;
                return;
              }
              selectCell(row, col);
            }}
            // Drag-select can't start from the ghost edge — there's nothing
            // there to select until it holds content.
            onLongPress={ghost ? undefined : () => armDrag(row, col)}
            delayLongPress={220}
            style={styles.cellPress}>
            <Text
              numberOfLines={1}
              style={[
                styles.cellText,
                {
                  // A highlighted cell derives its own legible ink, since the
                  // theme's text colour is near-white in dark mode and would
                  // vanish on a pale swatch.
                  color: style?.color ?? (style?.bg ? readableTextColor(style.bg) : colors.text),
                },
                style?.bold && styles.bold,
                style?.italic && styles.italic,
                (style?.underline || style?.strike) && {
                  textDecorationLine: style?.underline
                    ? style?.strike
                      ? 'underline line-through'
                      : 'underline'
                    : 'line-through',
                },
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
    <ScrollView
      horizontal
      scrollEnabled={!dragging}
      showsHorizontalScrollIndicator={false}
      // Scrolling moves the grid under the pointer, so the cached origin has to
      // follow it or every mapped cell is offset by the scroll distance.
      onScroll={measureOrigin}
      scrollEventThrottle={16}
      contentContainerStyle={styles.hScroll}>
      <View>
        {/* Column headers, pinned above the scrolling body. */}
        <View style={styles.headerRow}>
          <View style={[styles.gutterCorner, { borderColor: gridLine }]} />
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
            onMoveShouldSetResponder={onMoveShouldSetResponder}
            onResponderGrant={onResponderGrant}
            onResponderMove={onResponderMove}
            onResponderRelease={endDrag}
            onResponderTerminate={endDrag}>
            <View style={styles.gutter}>
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
            </View>
            {/* The origin and cell metrics have to be current at mouse-down,
                since `cellAt` reads them synchronously while `measureInWindow`
                is async — re-measuring on layout keeps them so. */}
            <View ref={contentRef} collapsable={false} onLayout={onContentLayout}>
              {rows.map((r) => (
                <View key={r} style={styles.row}>
                  {cols.map((c) => renderCell(r, c))}
                </View>
              ))}
            </View>
          </View>
        </ScrollView>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  hScroll: { paddingRight: 24 },
  headerRow: { flexDirection: 'row' },
  body: { flexDirection: 'row' },
  gutter: { width: GUTTER_W },
  gutterCorner: {
    width: GUTTER_W,
    height: HEADER_H,
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
  cell: {
    width: COL_W,
    height: ROW_H,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
  },
  /**
   * The active cell's ring. Every side is set explicitly: the base cell style
   * sets `borderRightWidth`/`borderBottomWidth` for the gridlines, and those
   * beat a plain `borderWidth` when styles are flattened — so a shorthand here
   * would leave the right and bottom edges hairline while the other two thicken.
   *
   * The cell's width and height are fixed, so the thicker border eats into the
   * cell rather than nudging its neighbours.
   */
  editingCell: {
    borderTopWidth: 2,
    borderRightWidth: 2,
    borderBottomWidth: 2,
    borderLeftWidth: 2,
    borderColor: ACTIVE_EDGE,
  },
  cellPress: { flex: 1, justifyContent: 'center', paddingHorizontal: 8 },
  /** The trailing row/column, before typing turns it into part of the sheet. */
  ghost: { opacity: 0.35 },
  cellText: { fontSize: 14, userSelect: 'none' },
  bold: { fontWeight: '700' },
  italic: { fontStyle: 'italic' },
  errorText: { fontWeight: '600', opacity: 0.9 },
  input: {
    flex: 1,
    paddingHorizontal: 8,
    fontSize: 14,
    // Web focus rings clash with the cell's own selection border.
    ...Platform.select({ web: { outlineStyle: 'none' as never }, default: {} }),
  },
});
