import { createRequire } from 'node:module';
import { AantjeError } from '../errors';
import type { AwsSdkModule } from './api';

let loaded: AwsSdkModule | undefined;

/**
 * Loads `dist/aws-sdk.js` once. It is a bundle of its own, which esbuild does not inline into extension.js, so the AWS
 * SDK costs nothing until an AWS command runs.
 */
export function loadAwsSdk(path: string): AwsSdkModule {
  if (loaded) return loaded;
  try {
    const module = createRequire(path)(path) as Partial<AwsSdkModule>;
    if (typeof module.createAwsApi !== 'function' || typeof module.rdsAuthToken !== 'function') {
      throw new Error(`${path} exports no createAwsApi or rdsAuthToken.`);
    }
    loaded = module as AwsSdkModule;
    return loaded;
  } catch (cause) {
    throw new AantjeError(
      'CONNECTION_FAILED',
      'The AWS SDK of aantje could not be loaded. Reinstall the extension.',
      {
        cause,
      },
    );
  }
}
