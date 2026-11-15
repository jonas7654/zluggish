export interface PrototypePage {
  csrf: string;
  riderName: string;
  settingsPath: string;
  ghosts: boolean;
  bridgeFolder: string;
  stravaMethod: 'paid' | 'free';
}
