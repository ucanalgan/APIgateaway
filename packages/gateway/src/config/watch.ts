import { watch as fsWatch, type FSWatcher } from 'node:fs';
import process from 'node:process';
import type { GatewayConfig } from './schema.js';
import { loadConfig } from './load.js';

export interface ConfigWatcher {
  close(): void;
}

export interface WatchOptions {
  readonly onReload: (config: GatewayConfig) => void | Promise<void>;
  readonly onError: (err: unknown) => void;
  readonly watchFile: boolean;
}

/**
 * SIGHUP her zaman bir reload dener; `watchFile: true` ise ayrıca dosya
 * değişikliklerini de izler. İkisinde de: yeni config doğrulamayı geçemezse
 * (ya da `onReload` reddederse) eskisi korunur, hata `onError`'a raporlanır
 * — gateway bozuk bir config yüzünden asla çökmez/durmaz (bkz. PLAN.md §7).
 *
 * Not: `fs.watch` bazı editörlerin "atomic write via rename" davranışında
 * (dosyayı silip yeniden yazma) izlemeyi sessizce kaybedebilir — bu
 * platformlar arası bilinen bir kısıt. SIGHUP her zaman güvenilir kalır.
 */
export function watchConfig(configPath: string, options: WatchOptions): ConfigWatcher {
  let reloading = false;

  const reload = (): void => {
    if (reloading) return; // çakışan reload'ları sıraya koymuyoruz, sadece atlıyoruz
    reloading = true;

    try {
      const config = loadConfig(configPath);
      Promise.resolve(options.onReload(config))
        .catch((err: unknown) => options.onError(err))
        .finally(() => {
          reloading = false;
        });
    } catch (err) {
      options.onError(err);
      reloading = false;
    }
  };

  process.on('SIGHUP', reload);

  let fileWatcher: FSWatcher | undefined;
  if (options.watchFile) {
    fileWatcher = fsWatch(configPath, { persistent: false }, reload);
  }

  return {
    close(): void {
      process.off('SIGHUP', reload);
      fileWatcher?.close();
    },
  };
}
