import { useFonts } from 'expo-font';
import { DarkTheme, router, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import 'react-native-reanimated';

import { useColorScheme } from '@/components/useColorScheme';
import { palette } from '@/src/ui/palette';
import { flushMobileSessionPersistence, useOpenCodeMobileStore } from '@/src/store/mobile-store';
import { CommandPalette } from '@/src/components/opencode/CommandPalette';
import { NoticeToast } from '@/src/components/opencode/NoticeToast';
import { settingsModalOptions } from '@/src/ux/settings-navigation';
import { useDesktopShell, useScreenActions } from '@/src/ux/use-desktop-shell';

export {
  // Catch any errors thrown by the Layout component.
  ErrorBoundary,
} from 'expo-router';

export const unstable_settings = {
  // Ensure that reloading on `/modal` keeps a back button present.
  initialRouteName: '(tabs)',
};

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [loaded, error] = useFonts({
    SpaceMono: require('../assets/fonts/SpaceMono-Regular.ttf'),
  });

  // Expo Router uses Error Boundaries to catch errors in the navigation tree.
  useEffect(() => {
    if (error) throw error;
  }, [error]);

  useEffect(() => {
    if (loaded) {
      SplashScreen.hideAsync();
    }
  }, [loaded]);

  if (!loaded) {
    return null;
  }

  return <RootLayoutNav />;
}

function RootLayoutNav() {
  useColorScheme();
  useDesktopShell();
  // Claimed at the root so the key works from any surface; a screen-level claim
  // would make it dead everywhere except that screen.
  const openCommandPalette = useOpenCodeMobileStore((state) => state.openCommandPalette);
  useScreenActions({
    'new-session': () => { router.push('/new-session'); },
    'session-list': () => { router.push('/(tabs)/two'); },
    'entrypoint:commands': () => { openCommandPalette(); },
    'entrypoint:settings': () => { router.push('/modal'); },
  }, [openCommandPalette]);
  const hydrate = useOpenCodeMobileStore((state) => state.hydrate);
  useEffect(() => {
    void hydrate();
  }, [hydrate]);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') void flushMobileSessionPersistence().catch(() => undefined);
    });
    return () => subscription.remove();
  }, []);
  const opencodeNavigationTheme = {
    ...DarkTheme,
    colors: {
      ...DarkTheme.colors,
      primary: palette.primary,
      background: palette.background,
      card: palette.backgroundPanel,
      text: palette.text,
      border: palette.borderSubtle,
      notification: palette.error,
    },
  };

  return (
    <ThemeProvider value={opencodeNavigationTheme}>
      <Stack>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="devices" options={{ headerShown: false }} />
          <Stack.Screen name="new-session" options={{ headerShown: false }} />
        <Stack.Screen name="session/[sessionKey]" options={{ headerShown: false, gestureEnabled: false }} />
        <Stack.Screen name="pair" options={{ headerShown: false }} />
        <Stack.Screen name="modal" options={settingsModalOptions} />
      </Stack>
      <CommandPalette />
      <NoticeToast />
    </ThemeProvider>
  );
}
