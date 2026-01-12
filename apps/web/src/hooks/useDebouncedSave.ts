import { useState, useEffect, useRef, useCallback } from 'react';
import type { Settings } from '@tracearr/shared';
import { useUpdateSettings } from './queries/useSettings';

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

interface UseDebouncedSaveOptions {
  delay?: number;
  onSaved?: () => void;
  onError?: (error: Error) => void;
}

/**
 * Hook for debounced auto-saving of settings fields.
 * Saves automatically after the specified delay (default 500ms) of inactivity.
 * Preserves user input on error - does not reset to server value.
 */
export function useDebouncedSave<K extends keyof Settings>(
  key: K,
  serverValue: Settings[K] | undefined,
  options: UseDebouncedSaveOptions = {}
) {
  const { delay = 500, onSaved, onError } = options;

  const [value, setValue] = useState<Settings[K] | undefined>(serverValue);
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const updateSettings = useUpdateSettings({ silent: true });
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef<Settings[K] | undefined>(serverValue);
  const hasErrorRef = useRef(false);
  const userHasEditedRef = useRef(false);

  const performSave = useCallback(
    (valueToSave: Settings[K] | undefined) => {
      setStatus('saving');
      updateSettings.mutate({ [key]: valueToSave ?? null } as Partial<Settings>, {
        onSuccess: () => {
          lastSavedRef.current = valueToSave;
          hasErrorRef.current = false;
          setErrorMessage(null);
          setStatus('saved');
          onSaved?.();
          if (statusTimeoutRef.current) {
            clearTimeout(statusTimeoutRef.current);
          }
          statusTimeoutRef.current = setTimeout(() => setStatus('idle'), 2000);
        },
        onError: (err) => {
          hasErrorRef.current = true;
          setErrorMessage(err.message || 'Failed to save');
          setStatus('error');
          onError?.(err);
        },
      });
    },
    [key, updateSettings, onSaved, onError]
  );

  // Sync with server value when it changes externally
  useEffect(() => {
    if (!hasErrorRef.current && status !== 'saving') {
      setValue(serverValue);
      lastSavedRef.current = serverValue;
    }
  }, [serverValue, status]);

  // Cleanup all timeouts on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      if (statusTimeoutRef.current) {
        clearTimeout(statusTimeoutRef.current);
      }
    };
  }, []);

  // Debounced save effect
  useEffect(() => {
    // Don't save if value matches last saved value
    if (value === lastSavedRef.current) {
      return;
    }

    if (!userHasEditedRef.current) {
      lastSavedRef.current = value;
      return;
    }

    if (status === 'saving') {
      return;
    }

    // Clear any existing timeout
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    if (hasErrorRef.current) {
      hasErrorRef.current = false;
      setErrorMessage(null);
    }

    setStatus('saving');

    timeoutRef.current = setTimeout(() => {
      performSave(value);
    }, delay);

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [value, delay, performSave, status]);

  const setValueWithTracking = useCallback((newValue: Settings[K] | undefined) => {
    userHasEditedRef.current = true;
    setValue(newValue);
  }, []);

  // Force immediate save (useful for programmatic changes like "Detect" button)
  const saveNow = useCallback(() => {
    // Prevent concurrent saves
    if (status === 'saving') {
      return;
    }

    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    userHasEditedRef.current = true;
    if (value !== lastSavedRef.current) {
      performSave(value);
    }
  }, [value, performSave, status]);

  const reset = useCallback(() => {
    hasErrorRef.current = false;
    setErrorMessage(null);
    setValue(serverValue);
    setStatus('idle');
  }, [serverValue]);

  const retry = useCallback(() => {
    saveNow();
  }, [saveNow]);

  return {
    value: value ?? ('' as Settings[K]),
    setValue: setValueWithTracking,
    status,
    errorMessage,
    saveNow,
    reset,
    retry,
    isDirty: value !== lastSavedRef.current,
    hasError: hasErrorRef.current,
  };
}
