import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

export function NotFound() {
  const { t } = useTranslation(['common', 'pages']);

  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center space-y-4">
      <h1 className="text-4xl font-bold">404</h1>
      <p className="text-muted-foreground">{t('common:errors.pageNotFound')}</p>
      <Button asChild>
        <Link to="/">{t('common:actions.goHome')}</Link>
      </Button>
    </div>
  );
}
