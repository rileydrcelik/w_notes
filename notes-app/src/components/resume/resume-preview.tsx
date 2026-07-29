/**
 * Native resume preview — a placeholder until there's a native LaTeX engine to
 * produce a PDF in the first place (see `lib/latex/engine.ts`). The screen never
 * mounts this today, since it checks `isLatexCompileSupported()` first; it
 * exists so the web/native pair stays complete and the import resolves.
 */
import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';

export function ResumePreview({ pdf: _pdf }: { pdf: Uint8Array }) {
  return (
    <View style={styles.container}>
      <ThemedText type="small" themeColor="textSecondary">
        Resume previews are available on the web app for now.
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    padding: Spacing.four,
  },
});
