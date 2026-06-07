import Feather from '@expo/vector-icons/Feather';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, useColorScheme, View } from 'react-native';
import Animated, {
  FadeIn,
  FadeOut,
  LinearTransition,
  SlideInRight,
  SlideOutRight,
} from 'react-native-reanimated';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { Colors, Spacing } from '@/constants/theme';
import { useNotes } from '@/store/notes-store';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/** Quick-access shortcuts above the note hierarchy. Favorites/Shared/Trash are dummy. */
const QUICK_ACCESS = [
  { id: 'favorites', label: 'Favorites', icon: 'star', count: 6 },
  { id: 'shared', label: 'Shared', icon: 'share-2', count: 3 },
  { id: 'trash', label: 'Trash', icon: 'trash-2', count: 2 },
] as const;

/**
 * Right-hand drawer (73.75% width) listing quick-access shortcuts and the full
 * note hierarchy. Rendered from inside the floating tab bar so the navbar
 * always stacks above it. Always mounted; the inner content mounts/unmounts on
 * `open` so the slide/fade exit animations get a chance to play.
 */
export function RightSidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const colors = Colors[scheme];
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { folders, notes, getNotesInFolder, getRootNotes, createFolder } = useNotes();
  const rootNotes = getRootNotes();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const toggle = (id: string) => setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));

  const openNote = (id: string) => {
    onClose();
    router.push({ pathname: '/note/[id]', params: { id } });
  };

  const addFolder = () => {
    const id = createFolder();
    onClose();
    router.push({ pathname: '/folder/[id]', params: { id } });
  };

  return (
    <View style={styles.overlay} pointerEvents={open ? 'box-none' : 'none'}>
      {open && (
        <>
          <AnimatedPressable
            entering={FadeIn.duration(200)}
            exiting={FadeOut.duration(200)}
            style={styles.backdrop}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close menu"
          />

          <Animated.View
            entering={SlideInRight.duration(260)}
            exiting={SlideOutRight.duration(220)}
            style={styles.panel}>
            <SafeAreaView edges={['top', 'right']} style={styles.safeArea}>
              {/* Quick-access sidebar */}
              <View style={[styles.sidebar, { backgroundColor: colors.background }]}>
                <Pressable
                  onPress={onClose}
                  style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
                  <ThemedText type="small" themeColor="textSecondary">
                    {notes.length}
                  </ThemedText>
                  <ThemedText style={[styles.rowLabel, styles.quickLabel]} numberOfLines={1}>
                    All Notes
                  </ThemedText>
                  <Feather name="layers" size={18} color={colors.text} style={styles.leadIcon} />
                </Pressable>
                {QUICK_ACCESS.map((item) => (
                  <Pressable
                    key={item.id}
                    onPress={onClose}
                    style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
                    <ThemedText type="small" themeColor="textSecondary">
                      {item.count}
                    </ThemedText>
                    <ThemedText style={[styles.rowLabel, styles.quickLabel]} numberOfLines={1}>
                      {item.label}
                    </ThemedText>
                    <Feather name={item.icon} size={18} color={colors.text} style={styles.leadIcon} />
                  </Pressable>
                ))}
              </View>

              {/* Notes-hierarchy sidebar */}
              <View style={[styles.sidebar, styles.notesSidebar, { backgroundColor: colors.background }]}>
                {/* Pinned header: create a new folder. */}
                <Pressable
                  onPress={addFolder}
                  accessibilityRole="button"
                  accessibilityLabel="New folder"
                  style={({ pressed }) => [
                    styles.newFolderButton,
                    { backgroundColor: colors.backgroundElement },
                    pressed && styles.pressed,
                  ]}>
                  <Feather name="folder-plus" size={26} color={colors.text} />
                </Pressable>
                <ScrollView
                  contentContainerStyle={[
                    styles.notesContent,
                    { paddingBottom: insets.bottom + Spacing.two },
                  ]}
                  showsVerticalScrollIndicator={false}>
                  {folders.map((folder) => {
                    const folderNotes = getNotesInFolder(folder.id);
                    const isOpen = expanded[folder.id];
                    return (
                      <Animated.View key={folder.id} layout={LinearTransition.duration(220)}>
                        <Pressable
                          onPress={() => toggle(folder.id)}
                          style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
                          <ThemedText type="small" themeColor="textSecondary">
                            {folderNotes.length}
                          </ThemedText>
                          <View style={styles.spacer} />
                          <Feather
                            name={isOpen ? 'chevron-down' : 'chevron-left'}
                            size={18}
                            color={colors.textSecondary}
                          />
                          <ThemedText style={styles.folderName} numberOfLines={1}>
                            {folder.name}
                          </ThemedText>
                        </Pressable>
                        {isOpen &&
                          folderNotes.map((note, index) => (
                            <AnimatedPressable
                              key={note.id}
                              entering={FadeIn.duration(160).delay(index * 25)}
                              exiting={FadeOut.duration(120)}
                              onPress={() => openNote(note.id)}
                              style={({ pressed }) => [
                                styles.row,
                                styles.childRow,
                                pressed && styles.pressed,
                              ]}>
                              <ThemedText type="small" style={styles.rowLabel} numberOfLines={1}>
                                {note.title}
                              </ThemedText>
                              <Feather
                                name="file-text"
                                size={16}
                                color={colors.textSecondary}
                                style={styles.leadIcon}
                              />
                            </AnimatedPressable>
                          ))}
                      </Animated.View>
                    );
                  })}

                  {rootNotes.map((note) => (
                    <AnimatedPressable
                      key={note.id}
                      layout={LinearTransition.duration(220)}
                      onPress={() => openNote(note.id)}
                      style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
                      <ThemedText style={styles.rowLabel} numberOfLines={1}>
                        {note.title}
                      </ThemedText>
                      <Feather name="file-text" size={18} color={colors.text} style={styles.leadIcon} />
                    </AnimatedPressable>
                  ))}
                </ScrollView>
                {/* Subtle fade so content dissolves into the bottom edge. */}
                <LinearGradient
                  pointerEvents="none"
                  colors={['transparent', 'rgba(0,0,0,0.85)']}
                  style={styles.bottomFade}
                />
              </View>
            </SafeAreaView>
          </Animated.View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  panel: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: 0,
    width: '73.75%',
  },
  safeArea: {
    flex: 1,
    gap: Spacing.three,
  },
  /** A standalone docked card, flush to the screen's right edge. */
  sidebar: {
    overflow: 'hidden',
    padding: Spacing.two,
    // Extra inset so the right-aligned content isn't jammed against the edge.
    paddingRight: Spacing.three,
    borderTopLeftRadius: Spacing.four,
    borderBottomLeftRadius: Spacing.four,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 24,
    shadowOffset: { width: -8, height: 0 },
    elevation: 24,
  },
  /** The lower sidebar takes the remaining height and scrolls internally. */
  notesSidebar: {
    flex: 1,
    // Reaches the screen's bottom edge, so its bottom-left corner stays square.
    borderBottomLeftRadius: 0,
  },
  notesContent: {
    gap: Spacing.one,
  },
  bottomFade: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: Spacing.six,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: Spacing.two,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.two,
    borderRadius: Spacing.two,
  },
  childRow: {
    marginRight: Spacing.four,
  },
  /** Pinned create-folder button above the scrolling hierarchy. */
  newFolderButton: {
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.six,
    marginBottom: Spacing.two,
    borderRadius: Spacing.three,
  },
  pressed: {
    opacity: 0.55,
  },
  leadIcon: {
    width: 20,
    textAlign: 'center',
  },
  rowLabel: {
    flex: 1,
    textAlign: 'right',
  },
  spacer: {
    flex: 1,
  },
  folderName: {
    flexShrink: 1,
    textAlign: 'right',
  },
  quickLabel: {
    fontSize: 18,
    lineHeight: 24,
  },
});
