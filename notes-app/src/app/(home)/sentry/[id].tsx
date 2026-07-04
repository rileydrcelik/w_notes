import Feather from '@expo/vector-icons/Feather';
import * as Clipboard from 'expo-clipboard';
import { Stack, useLocalSearchParams } from 'expo-router';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Linking,
  Pressable,
  RefreshControl,
  StyleSheet,
  View,
} from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SwipeBackView } from '@/components/swipe-back-view';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Fonts, hexToRgba, Spacing } from '@/constants/theme';
import { useContextMenu } from '@/hooks/use-context-menu';
import { useTabBarInset } from '@/hooks/use-tab-bar-inset';
import { useTheme } from '@/hooks/use-theme';
import { apiFetch } from '@/lib/sync/api';
import { sentryTarget } from '@/lib/sentry-note';
import { useAutofixSelection } from '@/store/autofix-selection-store';
import { useNotes } from '@/store/notes-store';

// Sentry level → dot color. Falls back to secondary text for unknown levels.
const LEVEL_COLORS: Record<string, string> = {
  fatal: '#e1567c',
  error: '#f55459',
  warning: '#eca611',
  info: '#3c87f7',
  debug: '#8d8f9c',
};

type Issue = {
  id: string;
  shortId?: string | null;
  title: string;
  culprit?: string | null;
  level?: string | null;
  status?: string | null;
  substatus?: string | null;
  platform?: string | null;
  logger?: string | null;
  count?: string | null;
  userCount?: number | null;
  firstSeen?: string | null;
  lastSeen?: string | null;
  permalink?: string | null;
  numComments?: number | null;
  isUnhandled?: boolean | null;
  metadataValue?: string | null;
  metadataType?: string | null;
  assignee?: string | null;
};

type IssueListResponse = { issues: Issue[]; next_cursor?: string | null };

// Backend /sentry/autofix responses.
type AutofixResponse = { dispatched: boolean; issue_id: string; short_id?: string | null; branch: string };
type AutofixStatusState = 'none' | 'branch_created' | 'pr_open' | 'pr_merged' | 'pr_closed';
type AutofixStatus = {
  state: AutofixStatusState;
  branch: string;
  pr_number?: number | null;
  pr_url?: string | null;
  title?: string | null;
};
// Per-issue autofix progress tracked on the screen (never synced).
type FixState = {
  phase: 'dispatching' | 'error' | 'tracking';
  shortId?: string;
  status?: AutofixStatus;
  stopped?: boolean; // polling gave up (timeout); keep the last status shown
  message?: string;
};

// A fix is still "in flight" (worth polling) until a PR shows up or we give up.
function isPollable(fix: FixState | undefined): boolean {
  return (
    !!fix &&
    fix.phase === 'tracking' &&
    !fix.stopped &&
    !!fix.shortId &&
    (fix.status?.state === 'none' || fix.status?.state === 'branch_created')
  );
}

type ContextLine = { lineno: number; code: string };

type StackFrame = {
  filename?: string | null;
  abs_path?: string | null;
  module?: string | null;
  package?: string | null;
  function?: string | null;
  lineno?: number | null;
  colno?: number | null;
  in_app?: boolean | null;
  context: ContextLine[];
};

type Tag = { key: string; value: string };

type Breadcrumb = {
  timestamp?: string | null;
  type?: string | null;
  category?: string | null;
  level?: string | null;
  message?: string | null;
};

type RequestInfo = { url?: string | null; method?: string | null };

type EventUser = {
  id?: string | null;
  email?: string | null;
  username?: string | null;
  ip_address?: string | null;
};

type LatestEvent = {
  id: string;
  title?: string | null;
  message?: string | null;
  culprit?: string | null;
  platform?: string | null;
  date_created?: string | null;
  exception_type?: string | null;
  exception_value?: string | null;
  // Arrays are optional: an older backend build omits tags/breadcrumbs entirely.
  frames?: StackFrame[] | null;
  tags?: Tag[] | null;
  breadcrumbs?: Breadcrumb[] | null;
  request?: RequestInfo | null;
  user?: EventUser | null;
};

/** Compact "3h ago" / "2d ago" style relative time from an ISO timestamp. */
function relativeTime(iso?: string | null): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

/** One stack frame as plain text (for clipboard): `function (file:line)`, plus
 * in-app source context with the errored line marked. */
function frameToClipboardText(frame: StackFrame): string {
  const loc = [frame.filename ?? frame.module, frame.lineno].filter(Boolean).join(':');
  const head = `  ${frame.function || '<anonymous>'}${loc ? `  (${loc})` : ''}`;
  if (frame.in_app && frame.context.length > 0) {
    const ctx = frame.context
      .map((c) => `    ${c.lineno === frame.lineno ? '>' : ' '} ${c.lineno} | ${c.code}`)
      .join('\n');
    return `${head}\n${ctx}`;
  }
  return head;
}

/** The full error as pasteable text: headline, exception, culprit, request, and
 * the stack trace (nearest the crash first) with source context. `event` is null
 * when its detail couldn't be fetched — then we fall back to the list fields. */
function issueToClipboardText(issue: Issue, event: LatestEvent | null): string {
  const headline = issue.title || issue.shortId || 'Issue';
  const lines: string[] = [issue.level ? `[${issue.level.toUpperCase()}] ${headline}` : headline];

  const exc = event
    ? [event.exception_type, event.exception_value ?? event.message].filter(Boolean).join(': ')
    : '';
  if (exc && exc !== headline) lines.push(exc);
  else if (!event && issue.metadataValue && issue.metadataValue !== issue.title)
    lines.push(issue.metadataValue);

  if (issue.culprit) lines.push(issue.culprit);
  if (event?.request?.url)
    lines.push(`Request: ${[event.request.method, event.request.url].filter(Boolean).join(' ')}`);

  const frames = event?.frames ? [...event.frames].reverse() : [];
  if (frames.length > 0)
    lines.push('', 'Stack trace (nearest the crash first):', frames.map(frameToClipboardText).join('\n'));

  const ref = [issue.shortId, issue.permalink].filter(Boolean).join('  ·  ');
  if (ref) lines.push('', ref);
  return lines.join('\n');
}

/**
 * One stack frame: `function` over `file:line`, plus (for in-app frames that
 * carry them) the surrounding source lines with the errored line highlighted.
 */
function FrameRow({ frame }: { frame: StackFrame }) {
  const theme = useTheme();
  const location = [frame.filename ?? frame.module, frame.lineno].filter(Boolean).join(':');
  // Show code only for app frames — library frames stay compact, as in Sentry.
  const showContext = frame.in_app && frame.context.length > 0;
  return (
    <View style={[styles.frame, frame.in_app && { borderLeftColor: '#7553FF' }]}>
      <ThemedText type="code" numberOfLines={1} themeColor={frame.in_app ? 'text' : 'textSecondary'}>
        {frame.function || '<anonymous>'}
      </ThemedText>
      {!!location && (
        <ThemedText type="code" numberOfLines={1} themeColor="textSecondary" style={styles.frameLoc}>
          {location}
        </ThemedText>
      )}
      {showContext && (
        <View style={styles.context}>
          {frame.context.map((line) => {
            const errored = line.lineno === frame.lineno;
            return (
              <View
                key={line.lineno}
                style={[styles.contextLine, errored && { backgroundColor: hexToRgba('#7553FF', 0.16) }]}>
                <ThemedText type="code" themeColor="textSecondary" style={styles.contextGutter}>
                  {line.lineno}
                </ThemedText>
                <ThemedText
                  type="code"
                  numberOfLines={1}
                  themeColor={errored ? 'text' : 'textSecondary'}
                  style={styles.contextCode}>
                  {line.code || ' '}
                </ThemedText>
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

/** A labelled value pair for the expanded detail grid. */
function DetailItem({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detailItem}>
      <ThemedText type="small" themeColor="textSecondary" style={styles.detailLabel}>
        {label}
      </ThemedText>
      <ThemedText type="smallBold" numberOfLines={1}>
        {value}
      </ThemedText>
    </View>
  );
}

/** A rounded key/value chip for a Sentry event tag (browser, os, release…). */
function TagChip({ tag }: { tag: Tag }) {
  return (
    <ThemedView type="backgroundElement" style={styles.chip}>
      <ThemedText type="small" themeColor="textSecondary" style={styles.chipKey}>
        {tag.key}
      </ThemedText>
      <ThemedText type="small" numberOfLines={1} style={styles.chipValue}>
        {tag.value}
      </ThemedText>
    </ThemedView>
  );
}

/** One breadcrumb in the trail leading up to the error. */
function BreadcrumbRow({ crumb }: { crumb: Breadcrumb }) {
  const dot = LEVEL_COLORS[crumb.level ?? ''] ?? '#8d8f9c';
  const label = crumb.category || crumb.type || 'event';
  return (
    <View style={styles.crumb}>
      <View style={[styles.crumbDot, { backgroundColor: dot }]} />
      <ThemedText type="small" themeColor="textSecondary" style={styles.crumbCat} numberOfLines={1}>
        {label}
      </ThemedText>
      <ThemedText type="small" numberOfLines={1} style={styles.crumbMsg}>
        {crumb.message || ''}
      </ThemedText>
    </View>
  );
}

/** A titled block inside the expanded card. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <ThemedText type="small" themeColor="textSecondary" style={styles.sectionLabel}>
        {title}
      </ThemedText>
      {children}
    </View>
  );
}

/** Small status pill shown on a card once its issue has been sent to autofix. */
function FixChip({ fix }: { fix: FixState }) {
  const prNum = fix.status?.pr_number;
  const prUrl = fix.status?.pr_url;

  let label = '';
  let spin = false;
  if (fix.phase === 'dispatching') {
    label = 'Sending to autofix…';
    spin = true;
  } else if (fix.phase === 'error') {
    label = fix.message || 'Autofix failed';
  } else {
    switch (fix.status?.state) {
      case 'pr_open':
        label = `PR #${prNum} open`;
        break;
      case 'pr_merged':
        label = `PR #${prNum} merged`;
        break;
      case 'pr_closed':
        label = `PR #${prNum} closed`;
        break;
      case 'branch_created':
        label = fix.stopped ? 'Still working — check GitHub' : 'Fixing…';
        spin = !fix.stopped;
        break;
      default:
        label = fix.stopped ? 'Still working — check GitHub' : 'Queued…';
        spin = !fix.stopped;
    }
  }

  const body = (
    <View style={styles.fixChip}>
      <Feather name="zap" size={12} color="#7553FF" />
      <ThemedText type="small" style={styles.fixChipText}>
        {label}
      </ThemedText>
      {spin && <ActivityIndicator size="small" color="#7553FF" />}
      {!!prUrl && <Feather name="external-link" size={12} color="#7553FF" />}
    </View>
  );

  if (prUrl) {
    return (
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={`Open ${label} on GitHub`}
        onPress={() => void Linking.openURL(prUrl)}
        style={({ pressed }) => pressed && styles.pressed}>
        {body}
      </Pressable>
    );
  }
  return body;
}

function IssueCard({
  issue,
  selectionActive,
  selected,
  onToggleSelect,
  fix,
}: {
  issue: Issue;
  selectionActive: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  fix?: FixState;
}) {
  const theme = useTheme();
  const dot = LEVEL_COLORS[issue.level ?? ''] ?? theme.textSecondary;
  const [expanded, setExpanded] = useState(false);
  const [event, setEvent] = useState<LatestEvent | null>(null);
  const [loadingEvent, setLoadingEvent] = useState(false);
  const [eventError, setEventError] = useState(false);
  // Guards against re-fetching on every render once a load has started. A ref
  // (not the loading flag) so it can't retrigger the effect and cancel itself.
  const startedRef = useRef(false);

  const meta = [
    issue.count ? `${issue.count} events` : null,
    issue.userCount ? `${issue.userCount} users` : null,
    relativeTime(issue.lastSeen) || null,
  ]
    .filter(Boolean)
    .join('  ·  ');

  // Lazily pull the latest event (stack trace) the first time the card opens.
  useEffect(() => {
    if (!expanded || startedRef.current) return;
    startedRef.current = true;
    let cancelled = false;
    setLoadingEvent(true);
    setEventError(false);
    apiFetch<LatestEvent>(`/sentry/issues/${encodeURIComponent(issue.id)}/latest-event`)
      .then((res) => {
        if (!cancelled) setEvent(res);
      })
      .catch(() => {
        if (!cancelled) {
          setEventError(true);
          startedRef.current = false; // allow a retry on next expand
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingEvent(false);
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, issue.id]);

  // Sentry lists frames oldest-first; show the crashing frame at the top.
  const frames = event?.frames ? [...event.frames].reverse() : [];
  // "ExceptionType: value" headline for the latest event, when present.
  const headline = event
    ? [event.exception_type, event.exception_value ?? event.message].filter(Boolean).join(': ')
    : '';

  // In selection mode a tap toggles the selection; otherwise it expands. A
  // long-press (or right-click on web) always toggles — that's what turns
  // selection mode on in the first place.
  const onPress = () => {
    if (selectionActive) onToggleSelect();
    else setExpanded((v) => !v);
  };
  const contextMenuRef = useContextMenu(onToggleSelect);

  return (
    <Pressable
      ref={contextMenuRef}
      accessibilityRole="button"
      accessibilityState={{ expanded, selected }}
      accessibilityLabel={
        selectionActive
          ? `${selected ? 'Deselect' : 'Select'} ${issue.shortId ?? issue.title}`
          : `${expanded ? 'Collapse' : 'Expand'} ${issue.shortId ?? issue.title}`
      }
      onPress={onPress}
      onLongPress={onToggleSelect}
      style={({ pressed }) => pressed && styles.pressed}>
      <ThemedView
        type="backgroundElementAlt"
        style={[styles.card, selected && styles.cardSelected]}>
        <View style={styles.cardHeader}>
          <View style={[styles.levelDot, { backgroundColor: dot }]} />
          <ThemedText
            type="smallBold"
            numberOfLines={expanded ? undefined : 1}
            style={styles.cardTitle}>
            {issue.title || issue.shortId || 'Issue'}
          </ThemedText>
          {selectionActive ? (
            <Feather
              name={selected ? 'check-circle' : 'circle'}
              size={18}
              color={selected ? '#7553FF' : theme.textSecondary}
            />
          ) : (
            <Feather
              name="chevron-down"
              size={16}
              color={theme.textSecondary}
              style={expanded && styles.chevronOpen}
            />
          )}
        </View>
        {!!issue.culprit && (
          <ThemedText
            type="small"
            themeColor="textSecondary"
            numberOfLines={expanded ? undefined : 1}>
            {issue.culprit}
          </ThemedText>
        )}
        {!!meta && (
          <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
            {meta}
          </ThemedText>
        )}

        {fix && <FixChip fix={fix} />}

        {expanded && (
          <Animated.View entering={FadeIn.duration(180)} style={styles.details}>
            {/* Headline error message (type: value), when we have it. */}
            {!!(headline || issue.metadataValue) && (
              <ThemedText type="code" style={styles.headline}>
                {headline || issue.metadataValue}
              </ThemedText>
            )}

            <View style={styles.detailGrid}>
              {!!issue.level && <DetailItem label="Level" value={issue.level.toUpperCase()} />}
              <DetailItem
                label="Handling"
                value={issue.isUnhandled ? 'Unhandled' : 'Handled'}
              />
              {!!issue.status && (
                <DetailItem
                  label="Status"
                  value={issue.substatus ? `${issue.status} · ${issue.substatus}` : issue.status}
                />
              )}
              {!!issue.shortId && <DetailItem label="Issue" value={issue.shortId} />}
              {!!issue.platform && <DetailItem label="Platform" value={issue.platform} />}
              {!!issue.logger && <DetailItem label="Logger" value={issue.logger} />}
              {!!issue.count && <DetailItem label="Events" value={issue.count} />}
              {issue.userCount != null && (
                <DetailItem label="Users" value={String(issue.userCount)} />
              )}
              {!!issue.firstSeen && (
                <DetailItem label="First seen" value={relativeTime(issue.firstSeen)} />
              )}
              {!!issue.lastSeen && (
                <DetailItem label="Last seen" value={relativeTime(issue.lastSeen)} />
              )}
              {!!issue.assignee && <DetailItem label="Assignee" value={issue.assignee} />}
              {!!issue.numComments && (
                <DetailItem label="Comments" value={String(issue.numComments)} />
              )}
            </View>

            {loadingEvent ? (
              <ActivityIndicator color={theme.textSecondary} style={styles.frameState} />
            ) : eventError ? (
              <ThemedText type="small" themeColor="textSecondary" style={styles.frameState}>
                Couldn’t load event details.
              </ThemedText>
            ) : event ? (
              <>
                {!!event.request?.url && (
                  <Section title="Request">
                    <ThemedText type="code" numberOfLines={2}>
                      {[event.request.method, event.request.url].filter(Boolean).join(' ')}
                    </ThemedText>
                  </Section>
                )}

                {!!event.user && (
                  <Section title="User">
                    <ThemedText type="small" numberOfLines={1}>
                      {[
                        event.user.username,
                        event.user.email,
                        event.user.id && `id ${event.user.id}`,
                        event.user.ip_address,
                      ]
                        .filter(Boolean)
                        .join('  ·  ') || '—'}
                    </ThemedText>
                  </Section>
                )}

                {frames.length > 0 && (
                  <Section title="Stack trace">
                    <View style={styles.frames}>
                      {frames.map((frame, i) => (
                        <FrameRow key={`${frame.filename}:${frame.lineno}:${i}`} frame={frame} />
                      ))}
                    </View>
                  </Section>
                )}

                {!!event.tags?.length && (
                  <Section title="Tags">
                    <View style={styles.chips}>
                      {event.tags.map((tag) => (
                        <TagChip key={`${tag.key}:${tag.value}`} tag={tag} />
                      ))}
                    </View>
                  </Section>
                )}

                {!!event.breadcrumbs?.length && (
                  <Section title="Breadcrumbs">
                    <View style={styles.crumbs}>
                      {event.breadcrumbs.map((crumb, i) => (
                        <BreadcrumbRow key={`${crumb.timestamp}:${i}`} crumb={crumb} />
                      ))}
                    </View>
                  </Section>
                )}

                {!!event.date_created && (
                  <ThemedText type="small" themeColor="textSecondary">
                    Event {event.id.slice(0, 8)} · {relativeTime(event.date_created)}
                  </ThemedText>
                )}
              </>
            ) : (
              <ThemedText type="small" themeColor="textSecondary" style={styles.frameState}>
                No event details available.
              </ThemedText>
            )}

            {!!issue.permalink && (
              <Pressable
                accessibilityRole="link"
                accessibilityLabel="Open this issue in Sentry"
                onPress={() => issue.permalink && void Linking.openURL(issue.permalink)}
                style={({ pressed }) => [styles.openLink, pressed && styles.pressed]}>
                <ThemedText type="small" style={{ color: '#7553FF' }}>
                  Open in Sentry
                </ThemedText>
                <Feather name="external-link" size={14} color="#7553FF" />
              </Pressable>
            )}
          </Animated.View>
        )}
      </ThemedView>
    </Pressable>
  );
}

export default function SentryIssuesScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { getNote } = useNotes();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const tabBarInset = useTabBarInset();
  const {
    active: selectionActive,
    selectedIds,
    isSelected,
    toggle,
    clear,
    registerFixHandler,
    registerIgnoreHandler,
    registerCopyHandler,
  } = useAutofixSelection();

  const note = getNote(id);
  // Memoize on the raw config so `target` keeps a stable identity across
  // renders — otherwise `load`/effect below refire every render and hammer the
  // issues endpoint (Sentry answers with 429s).
  const target = useMemo(
    () => (note ? sentryTarget(note) : null),
    [note?.pluginType, note?.pluginConfig],
  );

  const [issues, setIssues] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Per-issue autofix progress (kept in memory only — never synced). Keyed by
  // Sentry issue id. `attemptsRef` caps how long we poll each one.
  const [fixStates, setFixStates] = useState<Record<string, FixState>>({});
  const attemptsRef = useRef<Record<string, number>>({});

  const load = useCallback(
    async (mode: 'initial' | 'refresh') => {
      if (!target) {
        setLoading(false);
        setError('This Sentry note has no project configured.');
        return;
      }
      if (mode === 'refresh') setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const res = await apiFetch<IssueListResponse>(
          `/sentry/issues?org=${encodeURIComponent(target.org)}&project=${encodeURIComponent(
            target.project,
          )}&limit=25`,
        );
        setIssues(res.issues ?? []);
      } catch {
        setError('Could not load issues. Check the backend is reachable and the project exists.');
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [target],
  );

  useEffect(() => {
    void load('initial');
  }, [load]);

  // Ship the selected issues to the autofix pipeline. Fired by the navbar's Fix
  // button via the shared selection store. Each issue is dispatched independently
  // so one failure doesn't block the rest; selection clears once they're sent.
  const handleFix = useCallback(
    (ids: string[]) => {
      if (!target) return;
      ids.forEach((issueId) => {
        setFixStates((prev) => ({ ...prev, [issueId]: { phase: 'dispatching' } }));
        apiFetch<AutofixResponse>('/sentry/autofix', {
          method: 'POST',
          body: { issue_id: issueId, org: target.org, project: target.project },
        })
          .then((res) => {
            attemptsRef.current[issueId] = 0;
            setFixStates((prev) => ({
              ...prev,
              [issueId]: {
                phase: 'tracking',
                shortId: res.short_id ?? undefined,
                status: { state: 'none', branch: res.branch },
              },
            }));
          })
          .catch(() => {
            setFixStates((prev) => ({
              ...prev,
              [issueId]: { phase: 'error', message: 'Autofix failed to start' },
            }));
          });
      });
      clear();
    },
    [target, clear],
  );

  // Resolve the selected issues in Sentry (the navbar's "Ignore" action). Sentry
  // drops resolved issues from the unresolved list, so remove them locally right
  // away; on failure we put them back and surface the error banner.
  const handleIgnore = useCallback(
    (ids: string[]) => {
      const idSet = new Set(ids);
      const removed = issues.filter((i) => idSet.has(i.id));
      setIssues((prev) => prev.filter((i) => !idSet.has(i.id)));
      clear();
      ids.forEach((issueId) => {
        apiFetch(`/sentry/issues/${encodeURIComponent(issueId)}/resolve`, {
          method: 'POST',
        }).catch(() => {
          // Restore the ones that failed to resolve, preserving list order.
          const failed = removed.find((i) => i.id === issueId);
          if (failed) {
            setIssues((prev) => (prev.some((i) => i.id === issueId) ? prev : [failed, ...prev]));
          }
          setError('Could not resolve one or more issues in Sentry.');
        });
      });
    },
    [issues, clear],
  );

  // Copy the selected issues' full error text to the clipboard (the navbar's
  // "Copy error message" action). Fetches each issue's latest event so the copy
  // includes the exception + stack trace with source context — not just the
  // headline, and regardless of which cards happen to be expanded.
  const handleCopy = useCallback(
    (ids: string[]) => {
      const idSet = new Set(ids);
      const selected = issues.filter((i) => idSet.has(i.id));
      if (selected.length === 0) return;
      clear();
      void (async () => {
        const blocks = await Promise.all(
          selected.map(async (issue) => {
            try {
              const event = await apiFetch<LatestEvent>(
                `/sentry/issues/${encodeURIComponent(issue.id)}/latest-event`,
              );
              return issueToClipboardText(issue, event);
            } catch {
              // Fall back to the list fields for any issue whose detail failed.
              return issueToClipboardText(issue, null);
            }
          }),
        );
        await Clipboard.setStringAsync(blocks.join(`\n\n${'─'.repeat(48)}\n\n`));
      })();
    },
    [issues, clear],
  );

  // Register the handlers so the (screen-external) navbar menu (Fix / Dismiss /
  // Copy) can invoke them, and make sure selection doesn't linger once we leave.
  useEffect(() => {
    registerFixHandler(handleFix);
    return () => registerFixHandler(null);
  }, [registerFixHandler, handleFix]);
  useEffect(() => {
    registerIgnoreHandler(handleIgnore);
    return () => registerIgnoreHandler(null);
  }, [registerIgnoreHandler, handleIgnore]);
  useEffect(() => {
    registerCopyHandler(handleCopy);
    return () => registerCopyHandler(null);
  }, [registerCopyHandler, handleCopy]);
  useEffect(() => () => clear(), [clear]);

  // Poll the backend for each in-flight fix until a PR appears (or we give up).
  // One shared timer re-arms ~5s after each batch; terminal/timed-out fixes drop
  // out of `isPollable`, so the timer stops on its own once nothing is pending.
  useEffect(() => {
    const pending = Object.entries(fixStates).filter(([, s]) => isPollable(s));
    if (pending.length === 0) return;
    const timer = setTimeout(() => {
      void (async () => {
        for (const [issueId, s] of pending) {
          const attempts = (attemptsRef.current[issueId] ?? 0) + 1;
          attemptsRef.current[issueId] = attempts;
          const timedOut = attempts >= 24; // ~2 min at 5s
          try {
            const status = await apiFetch<AutofixStatus>(
              `/sentry/autofix/status?short_id=${encodeURIComponent(s.shortId!)}`,
            );
            setFixStates((prev) =>
              prev[issueId]
                ? { ...prev, [issueId]: { ...prev[issueId], status, stopped: timedOut } }
                : prev,
            );
          } catch {
            if (timedOut) {
              setFixStates((prev) =>
                prev[issueId]
                  ? { ...prev, [issueId]: { ...prev[issueId], stopped: true } }
                  : prev,
              );
            }
          }
        }
      })();
    }, 5000);
    return () => clearTimeout(timer);
  }, [fixStates]);

  const headerTop = insets.top + Spacing.four;

  return (
    <SwipeBackView>
      <ThemedView style={styles.container}>
        <Stack.Screen options={{ headerShown: false }} />
        <FlatList
          data={issues}
          keyExtractor={(item) => item.id}
          // Re-render rows when selection or any fix status changes.
          extraData={{ selectionActive, selectedIds, fixStates }}
          contentContainerStyle={[
            styles.content,
            { paddingTop: headerTop, paddingBottom: tabBarInset },
          ]}
          ListHeaderComponent={
            <View style={styles.header}>
              <View style={styles.headerTitleRow}>
                <Feather name="alert-triangle" size={22} color="#7553FF" />
                <ThemedText type="subtitle" numberOfLines={1} style={styles.headerTitle}>
                  {target?.project ?? 'Sentry'}
                </ThemedText>
              </View>
              {!!target?.org && (
                <ThemedText type="small" themeColor="textSecondary">
                  {target.org} · live issues
                </ThemedText>
              )}
            </View>
          }
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => void load('refresh')}
              tintColor={theme.textSecondary}
              colors={[theme.textSecondary]}
            />
          }
          ListEmptyComponent={
            loading ? (
              <ActivityIndicator style={styles.state} color={theme.textSecondary} />
            ) : error ? (
              <ThemedText themeColor="textSecondary" style={styles.state}>
                {error}
              </ThemedText>
            ) : (
              <ThemedText themeColor="textSecondary" style={styles.state}>
                No unresolved issues. 🎉
              </ThemedText>
            )
          }
          renderItem={({ item }) => (
            <IssueCard
              issue={item}
              selectionActive={selectionActive}
              selected={isSelected(item.id)}
              onToggleSelect={() => toggle(item.id)}
              fix={fixStates[item.id]}
            />
          )}
        />
      </ThemedView>
    </SwipeBackView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    paddingHorizontal: Spacing.three,
    gap: Spacing.two,
  },
  header: {
    gap: Spacing.one,
    marginBottom: Spacing.three,
  },
  headerTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  headerTitle: {
    flexShrink: 1,
  },
  card: {
    borderRadius: Spacing.three,
    padding: Spacing.three,
    gap: Spacing.half,
    borderWidth: 1.5,
    borderColor: 'transparent',
  },
  cardSelected: {
    borderColor: '#7553FF',
    backgroundColor: hexToRgba('#7553FF', 0.1),
  },
  fixChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    marginTop: Spacing.half,
  },
  fixChipText: {
    color: '#7553FF',
    fontSize: 12,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  levelDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  cardTitle: {
    flex: 1,
  },
  chevronOpen: {
    transform: [{ rotate: '180deg' }],
  },
  details: {
    marginTop: Spacing.two,
    gap: Spacing.three,
  },
  headline: {
    fontSize: 13,
    lineHeight: 18,
  },
  detailGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    rowGap: Spacing.two,
    columnGap: Spacing.three,
  },
  detailItem: {
    gap: Spacing.half,
    minWidth: 64,
  },
  detailLabel: {
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  section: {
    gap: Spacing.one,
  },
  sectionLabel: {
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  frames: {
    gap: Spacing.two,
  },
  frame: {
    borderLeftWidth: 2,
    borderLeftColor: 'transparent',
    paddingLeft: Spacing.two,
    gap: Spacing.half,
  },
  frameLoc: {
    fontFamily: Fonts.mono,
    fontSize: 11,
    opacity: 0.8,
  },
  context: {
    marginTop: Spacing.half,
    borderRadius: Spacing.one,
    overflow: 'hidden',
  },
  contextLine: {
    flexDirection: 'row',
    gap: Spacing.two,
    paddingVertical: 1,
    paddingHorizontal: Spacing.one,
  },
  contextGutter: {
    fontSize: 11,
    minWidth: 34,
    textAlign: 'right',
    opacity: 0.6,
  },
  contextCode: {
    flex: 1,
    fontSize: 11,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.one,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingVertical: Spacing.half,
    paddingHorizontal: Spacing.two,
    borderRadius: Spacing.two,
    maxWidth: '100%',
  },
  chipKey: {
    fontSize: 12,
  },
  chipValue: {
    fontSize: 12,
    flexShrink: 1,
  },
  crumbs: {
    gap: Spacing.half,
  },
  crumb: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  crumbDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  crumbCat: {
    fontSize: 12,
    minWidth: 72,
  },
  crumbMsg: {
    fontSize: 12,
    flex: 1,
  },
  frameState: {
    paddingVertical: Spacing.one,
  },
  openLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    alignSelf: 'flex-start',
    marginTop: Spacing.one,
  },
  pressed: {
    opacity: 0.6,
  },
  state: {
    textAlign: 'center',
    marginTop: Spacing.five,
  },
});
