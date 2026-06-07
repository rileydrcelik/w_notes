import Feather from '@expo/vector-icons/Feather';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, useColorScheme, View } from 'react-native';
import Animated, { FadeIn, FadeOut, SlideInRight, SlideOutRight } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { GlassSurface } from '@/components/glass-surface';
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
 * Right-hand drawer (66% width) listing quick-access shortcuts and the full
 * note hierarchy. Rendered from inside the floating tab bar so the navbar
 * always stacks above it. Always mounted; the inner content mounts/unmounts on
 * `open` so the slide/fade exit animations get a chance to play.
 */
export function RightSidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const colors = Colors[scheme];
  const router = useRouter();
  const { folders, notes, getNotesInFolder, getRootNotes } = useNotes();
  const rootNotes = getRootNotes();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const toggle = (id: string) => setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));

  const openNote = (id: string) => {
    onClose();
    router.push({ pathname: '/note/[id]', params: { id } });
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
            <GlassSurface intensity={60} style={styles.panelSurface}>
              <SafeAreaView edges={['top', 'right', 'bottom']} style={styles.safeArea}>
                <ScrollView
                  contentContainerStyle={styles.content}
                  showsVerticalScrollIndicator={false}>
                  <ThemedText type="subtitle">Library</ThemedText>

                  <ThemedText type="smallBold" themeColor="textSecondary" style={styles.sectionLabel}>
                    QUICK ACCESS
                  </ThemedText>
                  <Pressable
                    onPress={onClose}
                    style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
                    <Feather name="layers" size={18} color={colors.text} style={styles.leadIcon} />
                    <ThemedText style={styles.rowLabel} numberOfLines={1}>
                      All Notes
                    </ThemedText>
                    <ThemedText type="small" themeColor="textSecondary">
                      {notes.length}
                    </ThemedText>
                  </Pressable>
                  {QUICK_ACCESS.map((item) => (
                    <Pressable
                      key={item.id}
                      onPress={onClose}
                      style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
                      <Feather name={item.icon} size={18} color={colors.text} style={styles.leadIcon} />
                      <ThemedText style={styles.rowLabel} numberOfLines={1}>
                        {item.label}
                      </ThemedText>
                      <ThemedText type="small" themeColor="textSecondary">
                        {item.count}
                      </ThemedText>
                    </Pressable>
                  ))}

                  <ThemedText type="smallBold" themeColor="textSecondary" style={styles.sectionLabel}>
                    NOTES
                  </ThemedText>
                  {folders.map((folder) => {
                    const folderNotes = getNotesInFolder(folder.id);
                    const isOpen = expanded[folder.id];
                    return (
                      <View key={folder.id}>
                        <Pressable
                          onPress={() => toggle(folder.id)}
                          style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
                          <Feather
                            name={isOpen ? 'chevron-down' : 'chevron-right'}
                            size={18}
                            color={colors.textSecondary}
                            style={styles.leadIcon}
                          />
                          <ThemedText style={styles.rowLabel} numberOfLines={1}>
                            {folder.name}
                          </ThemedText>
                          <ThemedText type="small" themeColor="textSecondary">
                            {folderNotes.length}
                          </ThemedText>
                        </Pressable>
                        {isOpen &&
                          folderNotes.map((note) => (
                            <Pressable
                              key={note.id}
                              onPress={() => openNote(note.id)}
                              style={({ pressed }) => [
                                styles.row,
                                styles.childRow,
                                pressed && styles.pressed,
                              ]}>
                              <Feather
                                name="file-text"
                                size={16}
                                color={colors.textSecondary}
                                style={styles.leadIcon}
                              />
                              <ThemedText type="small" style={styles.rowLabel} numberOfLines={1}>
                                {note.title}
                              </ThemedText>
                            </Pressable>
                          ))}
                      </View>
                    );
                  })}

                  {rootNotes.map((note) => (
                    <Pressable
                      key={note.id}
                      onPress={() => openNote(note.id)}
                      style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
                      <Feather name="file-text" size={18} color={colors.text} style={styles.leadIcon} />
                      <ThemedText style={styles.rowLabel} numberOfLines={1}>
                        {note.title}
                      </ThemedText>
                    </Pressable>
                  ))}
                </ScrollView>
              </SafeAreaView>
            </GlassSurface>
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
    width: '66%',
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 24,
    shadowOffset: { width: -8, height: 0 },
    elevation: 24,
  },
  panelSurface: {
    flex: 1,
    borderTopLeftRadius: Spacing.four,
    borderBottomLeftRadius: Spacing.four,
  },
  safeArea: {
    flex: 1,
  },
  content: {
    padding: Spacing.four,
    gap: Spacing.one,
  },
  sectionLabel: {
    marginTop: Spacing.three,
    marginBottom: Spacing.one,
    letterSpacing: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.two,
    borderRadius: Spacing.two,
  },
  childRow: {
    marginLeft: Spacing.four,
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
  },
});
