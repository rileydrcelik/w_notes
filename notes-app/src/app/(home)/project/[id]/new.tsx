import Feather from '@expo/vector-icons/Feather';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { IssueAttributeEditors } from '@/components/notes/issue-attribute-editors';
import { SwipeBackView } from '@/components/swipe-back-view';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { hexToRgba, Spacing } from '@/constants/theme';
import { useTabBarInset } from '@/hooks/use-tab-bar-inset';
import { useTheme } from '@/hooks/use-theme';
import type { IssueAttrValue } from '@/data/notes';
import { newAttrId, parseTypeConfig, projectConfig, serializeProjectConfig } from '@/lib/project';
import {
  createGithubIssue,
  githubIssueAssignees,
  githubIssueBody,
  githubIssueLabels,
  githubSyncErrorMessage,
} from '@/lib/issue-github';
import { Sentry } from '@/lib/sentry';
import { useIssues } from '@/store/issues-store';
import { useNotes } from '@/store/notes-store';

const ACCENT = '#16a394';
const GITHUB_ACCENT = '#8250df';

export default function NewIssueScreen() {
  const { id, typeId } = useLocalSearchParams<{ id: string; typeId?: string }>();
  const router = useRouter();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const tabBarInset = useTabBarInset();
  const { getFolder, getNotesInFolder, updateFolder, createIssueTypeNote, deleteNote } = useNotes();
  const { createIssue, updateIssue, getIssuesForNote, deleteIssue } = useIssues();

  const folder = getFolder(id);
  const config = useMemo(() => (folder ? projectConfig(folder) : null), [folder?.kind, folder?.config]);
  const attributes = useMemo(() => config?.attributes ?? [], [config]);

  const typeNotes = useMemo(
    () =>
      getNotesInFolder(id)
        .filter((n) => n.pluginType === 'issuetype')
        .sort((a, b) => parseTypeConfig(a.pluginConfig).order - parseTypeConfig(b.pluginConfig).order),
    [getNotesInFolder, id],
  );

  // An issue can carry several types. Pre-select the type the (+) was pressed on
  // (else none — the user picks). The first selected type is the *primary* one
  // that drives the GitHub mirror.
  const [selectedTypeIds, setSelectedTypeIds] = useState<string[]>(typeId ? [typeId] : []);
  const toggleType = (t: string) =>
    setSelectedTypeIds((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));
  const primaryTypeId = selectedTypeIds[0] ?? null;

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [values, setValues] = useState<Record<string, IssueAttrValue>>({});

  // Inline "add type" / "add attribute" forms.
  const [newType, setNewType] = useState<string | null>(null); // null = closed
  const [newTypeConnected, setNewTypeConnected] = useState(true); // GitHub-tracked?
  const [newAttrName, setNewAttrName] = useState<string | null>(null); // null = closed
  const [newAttrOptions, setNewAttrOptions] = useState('');

  const change = (attrId: string, value: IssueAttrValue | undefined) =>
    setValues((prev) => {
      const next = { ...prev };
      if (value === undefined) delete next[attrId];
      else next[attrId] = value;
      return next;
    });

  const writeAttributes = useCallback(
    (attrs: typeof attributes) => {
      updateFolder(id, {
        config: serializeProjectConfig({ repo: config?.repo, attributes: attrs }),
      });
    },
    [id, updateFolder, config?.repo],
  );

  const removeAttr = useCallback(
    (attrId: string) => {
      writeAttributes(attributes.filter((a) => a.id !== attrId));
      change(attrId, undefined);
    },
    [attributes, writeAttributes],
  );

  const addOption = useCallback(
    (attrId: string, option: string) => {
      const opt = option.trim();
      if (!opt) return;
      writeAttributes(
        attributes.map((a) =>
          a.id === attrId
            ? { ...a, options: [...(a.options ?? []), opt].filter((v, i, arr) => arr.indexOf(v) === i) }
            : a,
        ),
      );
    },
    [attributes, writeAttributes],
  );

  const confirmAddAttr = () => {
    const name = (newAttrName ?? '').trim();
    if (!name) return;
    const options = newAttrOptions
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    writeAttributes([...attributes, { id: newAttrId(), name, type: 'select', options }]);
    setNewAttrName(null);
    setNewAttrOptions('');
  };

  const confirmAddType = () => {
    const name = (newType ?? '').trim();
    if (!name) return;
    const nextOrder =
      typeNotes.reduce((m, t) => Math.max(m, parseTypeConfig(t.pluginConfig).order), -1) + 1;
    // GitHub tracking only means something when the project has a repo.
    const created = createIssueTypeNote(id, name, !!config?.repo && newTypeConnected, nextOrder);
    setSelectedTypeIds((prev) => [...prev, created]);
    setNewType(null);
    setNewTypeConnected(true);
  };

  const removeType = (typeId: string) => {
    getIssuesForNote(typeId).forEach((i) => deleteIssue(i.id));
    deleteNote(typeId);
    setSelectedTypeIds((prev) => prev.filter((t) => t !== typeId));
  };

  // The primary (first-selected) type decides whether the issue mirrors to
  // GitHub; every selected type becomes a label so GitHub reflects them all.
  const primaryType = typeNotes.find((t) => t.id === primaryTypeId);
  const activeConnected = parseTypeConfig(primaryType?.pluginConfig).githubConnected;
  const selectedTypeTitles = selectedTypeIds
    .map((tid) => typeNotes.find((t) => t.id === tid)?.title)
    .filter((t): t is string => !!t);
  const canSave = selectedTypeIds.length > 0 && title.trim().length > 0;

  const save = () => {
    if (selectedTypeIds.length === 0 || !title.trim()) return;
    const trimmedTitle = title.trim();
    const trimmedDesc = description.trim();
    const issueId = createIssue({
      noteId: selectedTypeIds[0],
      typeIds: selectedTypeIds,
      title: trimmedTitle,
      description: trimmedDesc || undefined,
      attrs: values,
    });
    // Connected primary type + a project repo → open a matching GitHub issue in
    // the background and record its number (best-effort; failures stay local).
    // Every selected type rides along as a label, attributes render into the
    // issue body's managed block, and People values map to native GitHub assignees.
    if (activeConnected && config?.repo) {
      createGithubIssue(config.repo, {
        title: trimmedTitle,
        body: githubIssueBody(trimmedDesc, attributes, values),
        labels: githubIssueLabels(selectedTypeTitles),
        assignees: githubIssueAssignees(attributes, values),
      })
        .then((number) => updateIssue(issueId, { ghNumber: number }))
        .catch((e) => {
          Sentry.captureException(e, { tags: { source: 'issue-github', op: 'create' } });
          Alert.alert('Not opened on GitHub', githubSyncErrorMessage(e));
        });
    }
    router.back();
  };

  const headerTop = insets.top + Spacing.four;
  const border = hexToRgba(theme.text, 0.12);

  return (
    <SwipeBackView>
      <ThemedView style={styles.container}>
        <Stack.Screen options={{ headerShown: false }} />
        <ScrollView
          contentContainerStyle={[styles.content, { paddingTop: headerTop, paddingBottom: tabBarInset }]}
          keyboardShouldPersistTaps="handled">
          <View style={styles.headerTitleRow}>
            <Feather name="columns" size={22} color={ACCENT} />
            <ThemedText type="subtitle">New issue</ThemedText>
          </View>

          {/* Type picker — an issue can belong to several types. */}
          <ThemedText type="small" themeColor="textSecondary" style={styles.sectionLabel}>
            Types
          </ThemedText>
          <View style={styles.chips}>
            {typeNotes.map((t) => {
              const selected = selectedTypeIds.includes(t.id);
              const primary = primaryTypeId === t.id;
              // Two sibling Pressables inside a plain View — never a button nested
              // inside a button (which is invalid DOM on web).
              return (
                <View
                  key={t.id}
                  style={[
                    styles.typeChip,
                    { borderColor: selected ? ACCENT : border, backgroundColor: selected ? hexToRgba(ACCENT, 0.16) : 'transparent' },
                  ]}>
                  <Pressable
                    onPress={() => toggleType(t.id)}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: selected }}
                    accessibilityLabel={`Type ${t.title}`}
                    style={({ pressed }) => [styles.typeChipSelect, pressed && styles.pressed]}>
                    {selected && (
                      <Feather
                        name="check"
                        size={12}
                        color={ACCENT}
                        style={styles.typeChipCheck}
                      />
                    )}
                    <ThemedText
                      type={primary && selectedTypeIds.length > 1 ? 'smallBold' : 'small'}
                      numberOfLines={1}>
                      {t.title || 'Untitled'}
                    </ThemedText>
                  </Pressable>
                  <Pressable
                    onPress={() => removeType(t.id)}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${t.title} type`}
                    hitSlop={6}
                    style={({ pressed }) => pressed && styles.pressed}>
                    <Feather name="x" size={13} color={theme.textSecondary} />
                  </Pressable>
                </View>
              );
            })}
            {newType === null ? (
              <Pressable
                onPress={() => setNewType('')}
                accessibilityRole="button"
                accessibilityLabel="Add issue type"
                style={({ pressed }) => [styles.addChip, { borderColor: border }, pressed && styles.pressed]}>
                <Feather name="plus" size={14} color={theme.textSecondary} />
              </Pressable>
            ) : null}
          </View>
          {newType !== null && (
            <View style={styles.newTypeForm}>
              <View style={styles.inlineForm}>
                <TextInput
                  value={newType}
                  onChangeText={setNewType}
                  onSubmitEditing={confirmAddType}
                  placeholder="New type name"
                  placeholderTextColor={theme.textSecondary}
                  autoFocus
                  returnKeyType="done"
                  style={[styles.input, { color: theme.text, borderColor: border }]}
                />
                <Pressable
                  onPress={confirmAddType}
                  accessibilityRole="button"
                  accessibilityLabel="Add type"
                  style={({ pressed }) => [styles.smallCta, pressed && styles.pressed]}>
                  <Feather name="check" size={18} color="#FFFFFF" />
                </Pressable>
              </View>
              {!!config?.repo && (
                <Pressable
                  onPress={() => setNewTypeConnected((v) => !v)}
                  accessibilityRole="switch"
                  accessibilityState={{ checked: newTypeConnected }}
                  accessibilityLabel="Track with GitHub"
                  style={({ pressed }) => [
                    styles.typeToggle,
                    { borderColor: border },
                    pressed && styles.pressed,
                  ]}>
                  <Feather name="github" size={15} color={GITHUB_ACCENT} />
                  <ThemedText type="small" style={styles.typeToggleLabel}>
                    Track with GitHub
                  </ThemedText>
                  <View
                    style={[
                      styles.check,
                      newTypeConnected
                        ? { backgroundColor: ACCENT, borderColor: ACCENT }
                        : { borderColor: hexToRgba(theme.textSecondary, 0.4) },
                    ]}>
                    {newTypeConnected && <Feather name="check" size={14} color="#FFFFFF" />}
                  </View>
                </Pressable>
              )}
            </View>
          )}

          {activeConnected && config?.repo && (
            <View style={[styles.ghNote, { borderColor: hexToRgba(GITHUB_ACCENT, 0.35) }]}>
              <Feather name="github" size={13} color={GITHUB_ACCENT} style={styles.ghNoteIcon} />
              <ThemedText type="small" themeColor="textSecondary" style={styles.ghNoteText}>
                Opens a GitHub issue in {config.repo}. Needs the server token to allow Issues:
                Read/Write there — fine-grained: add the repo under Repository access + Issues write;
                classic: the repo scope.
              </ThemedText>
            </View>
          )}

          {/* Attributes */}
          <ThemedText type="small" themeColor="textSecondary" style={styles.sectionLabel}>
            Attributes
          </ThemedText>
          <IssueAttributeEditors
            attributes={attributes}
            values={values}
            onChange={change}
            onRemoveAttr={removeAttr}
            onAddOption={addOption}
            repo={config?.repo}
          />
          {newAttrName === null ? (
            <Pressable
              onPress={() => setNewAttrName('')}
              accessibilityRole="button"
              accessibilityLabel="Add attribute"
              style={({ pressed }) => [styles.addAttrRow, pressed && styles.pressed]}>
              <Feather name="plus" size={15} color={ACCENT} />
              <ThemedText type="small" style={{ color: ACCENT }}>
                Add attribute
              </ThemedText>
            </Pressable>
          ) : (
            <View style={styles.attrForm}>
              <TextInput
                value={newAttrName}
                onChangeText={setNewAttrName}
                placeholder="Attribute name"
                placeholderTextColor={theme.textSecondary}
                autoFocus
                style={[styles.input, { color: theme.text, borderColor: border }]}
              />
              <TextInput
                value={newAttrOptions}
                onChangeText={setNewAttrOptions}
                placeholder="Options, comma separated"
                placeholderTextColor={theme.textSecondary}
                style={[styles.input, { color: theme.text, borderColor: border }]}
              />
              <View style={styles.attrFormActions}>
                <Pressable
                  onPress={() => {
                    setNewAttrName(null);
                    setNewAttrOptions('');
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="Cancel attribute"
                  style={({ pressed }) => [styles.attrCancel, pressed && styles.pressed]}>
                  <ThemedText type="small" themeColor="textSecondary">
                    Cancel
                  </ThemedText>
                </Pressable>
                <Pressable
                  onPress={confirmAddAttr}
                  accessibilityRole="button"
                  accessibilityLabel="Save attribute"
                  style={({ pressed }) => [styles.smallCta, styles.attrSave, pressed && styles.pressed]}>
                  <ThemedText type="small" style={styles.smallCtaText}>
                    Add
                  </ThemedText>
                </Pressable>
              </View>
            </View>
          )}

          {/* Title + description */}
          <ThemedText type="small" themeColor="textSecondary" style={styles.sectionLabel}>
            Details
          </ThemedText>
          <TextInput
            value={title}
            onChangeText={setTitle}
            placeholder="Title"
            placeholderTextColor={theme.textSecondary}
            style={[styles.input, { color: theme.text, borderColor: border }]}
          />
          <TextInput
            value={description}
            onChangeText={setDescription}
            placeholder="Description (optional)"
            placeholderTextColor={theme.textSecondary}
            multiline
            style={[styles.input, styles.descInput, { color: theme.text, borderColor: border }]}
          />

          <Pressable
            onPress={save}
            disabled={!canSave}
            accessibilityRole="button"
            accessibilityLabel="Create issue"
            accessibilityState={{ disabled: !canSave }}
            style={({ pressed }) => [styles.cta, !canSave && styles.ctaDisabled, pressed && canSave && styles.pressed]}>
            <ThemedText style={styles.ctaText}>Create issue</ThemedText>
          </Pressable>
        </ScrollView>
      </ThemedView>
    </SwipeBackView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { paddingHorizontal: Spacing.three, gap: Spacing.two },
  headerTitleRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two, marginBottom: Spacing.two },
  sectionLabel: {
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    fontSize: 11,
    marginTop: Spacing.two,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.one, alignItems: 'center' },
  typeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingVertical: Spacing.one,
    paddingHorizontal: Spacing.two,
    borderRadius: Spacing.two,
    borderWidth: 1.5,
  },
  typeChipSelect: { flexDirection: 'row', alignItems: 'center' },
  typeChipCheck: { marginRight: Spacing.one },
  addChip: {
    paddingVertical: Spacing.one,
    paddingHorizontal: Spacing.two,
    borderRadius: Spacing.two,
    borderWidth: 1.5,
    borderStyle: 'dashed',
  },
  newTypeForm: { gap: Spacing.two },
  inlineForm: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  typeToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    borderWidth: 1.5,
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  typeToggleLabel: { flex: 1, fontWeight: '600' },
  check: {
    width: 26,
    height: 26,
    borderRadius: Spacing.two,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  input: {
    flex: 1,
    borderWidth: 1.5,
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    fontSize: 15,
  },
  descInput: { minHeight: 90, textAlignVertical: 'top' },
  smallCta: {
    backgroundColor: ACCENT,
    borderRadius: Spacing.two,
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  smallCtaText: { color: '#FFFFFF', fontWeight: '600' },
  addAttrRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    alignSelf: 'flex-start',
    paddingVertical: Spacing.one,
  },
  ghNote: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.one,
    borderRadius: Spacing.three,
    borderWidth: 1.5,
    padding: Spacing.two,
    marginTop: Spacing.one,
  },
  ghNoteIcon: { marginTop: 1 },
  ghNoteText: { flex: 1, lineHeight: 18 },
  attrForm: { gap: Spacing.two },
  attrFormActions: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: Spacing.two },
  attrCancel: { paddingHorizontal: Spacing.three, paddingVertical: Spacing.two },
  attrSave: { width: 'auto', height: 'auto', paddingHorizontal: Spacing.three, paddingVertical: Spacing.two },
  cta: {
    backgroundColor: ACCENT,
    borderRadius: Spacing.three,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    marginTop: Spacing.three,
  },
  ctaDisabled: { opacity: 0.4 },
  ctaText: { color: '#FFFFFF', fontWeight: '600', fontSize: 15 },
  pressed: { opacity: 0.6 },
});
