export type LakeSize = 'small' | 'medium';

export interface SizePreset {
  readonly label: string;
  readonly description: string;
  /** The catalog server, as the template names it; the wizard asks the region whether it offers it. */
  readonly serverSku: string;
  readonly storageSku: string;
}

/** Keep in step with `sizes` in `deploy/azure/main.bicep`. Prices change and differ by region, so none are listed here. */
export const SIZES: Readonly<Record<LakeSize, SizePreset>> = {
  small: {
    label: 'Small',
    description: 'PostgreSQL Burstable B1ms with 32 GiB, locally redundant storage',
    serverSku: 'Standard_B1ms',
    storageSku: 'Standard_LRS',
  },
  medium: {
    label: 'Medium',
    description: 'PostgreSQL General Purpose D2ds v5 with 128 GiB, zone-redundant storage',
    serverSku: 'Standard_D2ds_v5',
    storageSku: 'Standard_ZRS',
  },
};

export const SIZE_NAMES = Object.keys(SIZES) as LakeSize[];
