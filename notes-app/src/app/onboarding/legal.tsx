import { useState } from 'react';
import { Alert, View, Text, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';

export default function LegalScreen() {
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleAgree = async () => {
    setLoading(true);
    try {
      const response = await fetch('https://aiko-production-eb27.up.railway.app/legal/accept', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error('Failed to accept terms');
      }

      const data = await response.json();
      if (data.success) {
        router.replace('/');
      } else {
        router.replace('/');
      }
    } catch (e: any) {
      Alert.alert('Error', e.message || 'Failed to accept terms');
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <ScrollView style={styles.content} contentContainerStyle={styles.scrollContent}>
        <Text style={styles.title}>Legal Terms</Text>
        <Text style={styles.body}>
          Please read and accept our legal terms to continue using the application.
        </Text>
      </ScrollView>
      <View style={styles.buttonContainer}>
        <View style={styles.button}>
          {loading ? (
            <ActivityIndicator size="large" color="#fff" />
          ) : (
            <Text style={styles.buttonText} onPress={handleAgree}>
              I Agree
            </Text>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  content: {
    flex: 1,
  },
  scrollContent: {
    padding: 20,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 16,
  },
  body: {
    fontSize: 16,
    lineHeight: 24,
    color: '#333',
  },
  buttonContainer: {
    padding: 20,
    borderTopWidth: 1,
    borderTopColor: '#eee',
  },
  button: {
    backgroundColor: '#007AFF',
    borderRadius: 8,
    padding: 16,
    alignItems: 'center',
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});
