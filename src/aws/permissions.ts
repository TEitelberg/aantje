// Who the credentials are, as an IAM principal, and what creating a lake needs of it. IAM's policy simulation answers
// for the identity policies and permission boundaries of the principal; it does not see service control policies or
// every condition, so CloudFormation can still refuse, and a failed creation is cleaned up.

/** What creating a lake calls, through CloudFormation (with the caller's credentials) and through aantje itself. */
export const CREATE_ACTIONS: readonly string[] = [
  'cloudformation:CreateChangeSet',
  'cloudformation:DescribeChangeSet',
  'cloudformation:ExecuteChangeSet',
  'cloudformation:DescribeStacks',
  'cloudformation:DescribeStackEvents',
  'cloudformation:DeleteStack',
  'cloudformation:UpdateTerminationProtection',
  'ec2:CreateVpc',
  'ec2:ModifyVpcAttribute',
  'ec2:CreateInternetGateway',
  'ec2:AttachInternetGateway',
  'ec2:CreateRouteTable',
  'ec2:CreateRoute',
  'ec2:CreateSubnet',
  'ec2:AssociateRouteTable',
  'ec2:CreateSecurityGroup',
  'ec2:AuthorizeSecurityGroupIngress',
  'ec2:CreateTags',
  'ec2:DescribeVpcs',
  'ec2:DescribeSubnets',
  'ec2:DescribeAvailabilityZones',
  'ec2:DescribeSecurityGroups',
  'ec2:DescribeInternetGateways',
  'ec2:DescribeRouteTables',
  'ec2:DeleteVpc',
  'ec2:DeleteSubnet',
  'ec2:DetachInternetGateway',
  'ec2:DeleteInternetGateway',
  'ec2:DeleteRouteTable',
  'ec2:DeleteRoute',
  'ec2:DisassociateRouteTable',
  'ec2:DeleteSecurityGroup',
  'rds:CreateDBInstance',
  'rds:CreateDBSubnetGroup',
  'rds:CreateDBParameterGroup',
  'rds:ModifyDBParameterGroup',
  'rds:AddTagsToResource',
  'rds:DescribeDBInstances',
  'rds:DescribeDBSubnetGroups',
  'rds:DescribeDBParameterGroups',
  'rds:DeleteDBInstance',
  'rds:DeleteDBSubnetGroup',
  'rds:DeleteDBParameterGroup',
  's3:CreateBucket',
  's3:PutBucketPolicy',
  's3:PutBucketPublicAccessBlock',
  's3:PutEncryptionConfiguration',
  's3:PutBucketOwnershipControls',
  's3:PutBucketTagging',
  's3:DeleteBucket',
  's3:DeleteBucketPolicy',
];

/** What the principal of an identity ARN is, for the bucket policy and the simulation. */
export type Principal =
  | { readonly kind: 'user'; readonly arn: string }
  | { readonly kind: 'role'; readonly roleName: string }
  | { readonly kind: 'root' }
  | { readonly kind: 'other' };

/**
 * An IAM user is its own ARN. An assumed role (also IAM Identity Center) is `assumed-role/<role>/<session>`: its role
 * ARN has a path that only IAM knows (`/aws-reserved/sso.amazonaws.com/` for Identity Center), so it is read with
 * `iam:GetRole`. The root user and federated users get no grant of their own.
 */
export function principalOf(arn: string): Principal {
  if (/^arn:aws[a-z-]*:iam::\d{12}:root$/.test(arn)) return { kind: 'root' };
  if (/^arn:aws[a-z-]*:iam::\d{12}:user\//.test(arn)) return { kind: 'user', arn };
  const role = /^arn:aws[a-z-]*:sts::\d{12}:assumed-role\/([^/]+)\//.exec(arn)?.[1];
  return role === undefined ? { kind: 'other' } : { kind: 'role', roleName: role };
}
