import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'LinkMate',
  version: '0.1.0',
  description: 'LinkedIn SSI growth assistant: track score, daily actions, AI comment drafts.',
  action: { default_title: 'LinkMate' },
  side_panel: { default_path: 'src/ui/panel/index.html' },
  permissions: ['storage', 'sidePanel', 'alarms', 'activeTab'],
  host_permissions: ['https://*.linkedin.com/*'],
  background: { service_worker: 'src/background/index.ts', type: 'module' },
  content_scripts: [
    {
      matches: ['https://*.linkedin.com/sales/ssi*'],
      js: ['src/content/ssi.ts'],
      run_at: 'document_idle',
    },
    {
      matches: ['https://*.linkedin.com/in/*'],
      js: ['src/content/profile.ts'],
      run_at: 'document_idle',
    },
    {
      matches: ['https://*.linkedin.com/feed/*', 'https://*.linkedin.com/feed'],
      js: ['src/content/feed.ts'],
      run_at: 'document_idle',
    },
  ],
  icons: { '16': 'icons/16.png', '48': 'icons/48.png', '128': 'icons/128.png' },
});
