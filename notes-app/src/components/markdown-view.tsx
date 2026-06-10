import Feather from '@expo/vector-icons/Feather';
import { Fragment } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Fonts, Spacing, hexToRgba } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { parseMarkdown, type Block, type InlineToken } from '@/lib/markdown';

type Props = {
  text: string;
  /** Called with the new full text when a checkbox is tapped. */
  onToggleCheckbox?: (line: number) => void;
  /** Called with a raw-source caret offset when a word is tapped, for editing. */
  onPressAt?: (offset: number) => void;
};

/** Renders the "basic Markdown" subset, with tappable checkboxes and words. */
export function MarkdownView({ text, onToggleCheckbox, onPressAt }: Props) {
  const blocks = parseMarkdown(text);

  return (
    <View>
      {blocks.map((block, i) => (
        <BlockView key={i} block={block} onToggleCheckbox={onToggleCheckbox} onPressAt={onPressAt} />
      ))}
    </View>
  );
}

function BlockView({
  block,
  onToggleCheckbox,
  onPressAt,
}: {
  block: Block;
  onToggleCheckbox?: (line: number) => void;
  onPressAt?: (offset: number) => void;
}) {
  const theme = useTheme();

  switch (block.kind) {
    case 'blank':
      return <View style={styles.blank} />;

    case 'heading': {
      const size = block.level === 1 ? styles.h1 : block.level === 2 ? styles.h2 : styles.h3;
      return (
        <Text style={[size, { color: theme.text }]}>
          <Inline tokens={block.tokens} onPressWord={onPressAt} />
        </Text>
      );
    }

    // Tapping the box toggles; the label stays a toggle target too, matching
    // how to-do lists usually behave — so checkbox labels aren't edit targets.
    case 'checkbox':
      return (
        <Pressable
          onPress={() => onToggleCheckbox?.(block.line)}
          hitSlop={6}
          style={styles.listRow}>
          <Feather
            name={block.checked ? 'check-square' : 'square'}
            size={18}
            color={block.checked ? theme.textSecondary : theme.text}
            style={styles.checkIcon}
          />
          <Text
            style={[
              styles.body,
              { color: block.checked ? theme.textSecondary : theme.text },
              block.checked && styles.checkedText,
            ]}>
            <Inline tokens={block.tokens} />
          </Text>
        </Pressable>
      );

    case 'bullet':
      return (
        <View style={styles.listRow}>
          <Text style={[styles.bulletDot, { color: theme.textSecondary }]}>•</Text>
          <Text style={[styles.body, { color: theme.text }]}>
            <Inline tokens={block.tokens} onPressWord={onPressAt} />
          </Text>
        </View>
      );

    case 'ordered':
      return (
        <View style={styles.listRow}>
          <Text style={[styles.orderedMarker, { color: theme.textSecondary }]}>{block.marker}</Text>
          <Text style={[styles.body, { color: theme.text }]}>
            <Inline tokens={block.tokens} onPressWord={onPressAt} />
          </Text>
        </View>
      );

    case 'quote':
      return (
        <View style={[styles.quote, { borderLeftColor: theme.backgroundSelected }]}>
          <Text style={[styles.body, { color: theme.textSecondary }]}>
            <Inline tokens={block.tokens} onPressWord={onPressAt} />
          </Text>
        </View>
      );

    case 'code':
      return (
        <Pressable onPress={() => onPressAt?.(block.offset)}>
          <View style={[styles.codeBlock, { backgroundColor: theme.backgroundElementAlt }]}>
            <Text style={[styles.codeText, { color: theme.text }]}>{block.text}</Text>
          </View>
        </Pressable>
      );

    case 'paragraph':
      return (
        <Text style={[styles.body, { color: theme.text }]}>
          <Inline tokens={block.tokens} onPressWord={onPressAt} />
        </Text>
      );
  }
}

/**
 * Renders a line's inline runs as nested styled <Text>. When `onPressWord` is
 * set, each word is individually tappable and reports its raw-source offset so
 * a tap can place the caret exactly there.
 */
function Inline({
  tokens,
  onPressWord,
}: {
  tokens: InlineToken[];
  onPressWord?: (offset: number) => void;
}) {
  const theme = useTheme();
  return (
    <>
      {tokens.map((token, i) => (
        <Fragment key={i}>{renderToken(token, theme, onPressWord)}</Fragment>
      ))}
    </>
  );
}

function renderToken(
  token: InlineToken,
  theme: ReturnType<typeof useTheme>,
  onPressWord?: (offset: number) => void,
) {
  const markStyle = [token.bold && styles.bold, token.italic && styles.italic];

  if (token.code) {
    return (
      <Text
        style={[styles.inlineCode, { backgroundColor: hexToRgba(theme.textSecondary, 0.15) }]}
        onPress={onPressWord ? () => onPressWord(token.offset) : undefined}>
        {token.text}
      </Text>
    );
  }

  if (!onPressWord) {
    return <Text style={markStyle}>{token.text}</Text>;
  }

  // Split into words while keeping whitespace, so each word is its own caret
  // target but the line still wraps and spaces naturally. Whitespace pieces
  // render as plain inherited text (they inherit the parent's bold/italic).
  const parts = token.text.split(/(\s+)/);
  let idx = 0;
  return (
    <Text style={markStyle}>
      {parts.map((part, j) => {
        const at = token.offset + idx;
        idx += part.length;
        if (part.length === 0) return null;
        if (/^\s+$/.test(part)) return <Fragment key={j}>{part}</Fragment>;
        return (
          <Text key={j} onPress={() => onPressWord(at)}>
            {part}
          </Text>
        );
      })}
    </Text>
  );
}

const styles = StyleSheet.create({
  blank: {
    height: Spacing.three,
  },
  body: {
    fontSize: 16,
    lineHeight: 24,
    fontWeight: '500',
    flex: 1,
  },
  h1: {
    fontSize: 28,
    lineHeight: 36,
    fontWeight: '700',
    marginVertical: Spacing.one,
  },
  h2: {
    fontSize: 22,
    lineHeight: 30,
    fontWeight: '700',
    marginVertical: Spacing.one,
  },
  h3: {
    fontSize: 18,
    lineHeight: 26,
    fontWeight: '700',
    marginVertical: Spacing.one,
  },
  listRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
    paddingVertical: 2,
  },
  checkIcon: {
    marginTop: 3,
  },
  checkedText: {
    textDecorationLine: 'line-through',
  },
  bulletDot: {
    fontSize: 16,
    lineHeight: 24,
  },
  orderedMarker: {
    fontSize: 16,
    lineHeight: 24,
    fontWeight: '600',
    minWidth: 18,
  },
  quote: {
    borderLeftWidth: 3,
    paddingLeft: Spacing.three,
    paddingVertical: 2,
  },
  codeBlock: {
    borderRadius: Spacing.two,
    padding: Spacing.three,
  },
  codeText: {
    fontFamily: Fonts.mono,
    fontSize: 13,
    lineHeight: 19,
  },
  inlineCode: {
    fontFamily: Fonts.mono,
    fontSize: 14,
  },
  bold: {
    fontWeight: '700',
  },
  italic: {
    fontStyle: 'italic',
  },
});
