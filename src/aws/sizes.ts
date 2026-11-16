/** The two sizes of the template (its mapping `Sizes`); change instance and storage later on the instance itself. */
export type AwsLakeSize = 'small' | 'medium';

export const AWS_SIZE_NAMES: readonly AwsLakeSize[] = ['small', 'medium'];

export const AWS_SIZES: Readonly<
  Record<AwsLakeSize, { label: string; description: string; instanceClass: string; multiAz: boolean }>
> = {
  small: {
    label: 'Small',
    description: 'db.t4g.small, 32 GiB gp3, Single-AZ',
    instanceClass: 'db.t4g.small',
    multiAz: false,
  },
  medium: {
    label: 'Medium',
    description: 'db.m7g.large, 128 GiB gp3, Multi-AZ',
    instanceClass: 'db.m7g.large',
    multiAz: true,
  },
};

/** The major versions of PostgreSQL that the template allows, newest first. */
export const POSTGRES_MAJORS: readonly number[] = [18, 17, 16, 15, 14];
