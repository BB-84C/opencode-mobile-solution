import { SymbolView } from 'expo-symbols';
import { Tabs } from 'expo-router';

import { palette } from '@/src/ui/palette';

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: palette.primary,
        tabBarInactiveTintColor: palette.textMuted,
        tabBarStyle: {
          backgroundColor: palette.backgroundPanel,
          borderTopColor: palette.borderSubtle,
        },
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: '600',
        },
        sceneStyle: {
          backgroundColor: palette.background,
        },
        tabBarHideOnKeyboard: true,
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Hosts',
          tabBarIcon: ({ color }) => (
            <SymbolView
              name={{ ios: 'server.rack', android: 'dns', web: 'dns' }}
              tintColor={color}
              size={22}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="two"
        options={{
          title: 'Sessions',
          tabBarIcon: ({ color }) => (
            <SymbolView
              name={{ ios: 'text.bubble', android: 'forum', web: 'forum' }}
              tintColor={color}
              size={22}
            />
          ),
        }}
      />
    </Tabs>
  );
}
