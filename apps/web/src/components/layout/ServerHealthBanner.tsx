import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useSocket } from '@/hooks/useSocket';

/**
 * Banner that displays when one or more servers are unreachable.
 * Updates in real-time via WebSocket events.
 */
export function ServerHealthBanner() {
  const { t } = useTranslation('settings');
  const { unhealthyServers } = useSocket();

  if (unhealthyServers.length === 0) {
    return null;
  }

  const serverNames = unhealthyServers.map((s) => s.serverName).join(', ');
  const message =
    unhealthyServers.length === 1
      ? t('serverHealth.unreachable', { serverName: serverNames })
      : t('serverHealth.multipleUnreachable', {
          count: unhealthyServers.length,
          serverNames,
        });

  return (
    <Alert
      variant="destructive"
      className="bg-destructive/15 flex items-center rounded-none border-x-0 border-t-0 [&>svg]:!top-1/2 [&>svg]:!-translate-y-1/2 [&>svg+div]:!translate-y-0"
    >
      <AlertTriangle className="h-4 w-4" />
      <AlertDescription className="ml-2 flex-1">{message}</AlertDescription>
    </Alert>
  );
}
