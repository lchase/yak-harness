import type {ReactNode} from 'react';
import {Redirect} from '@docusaurus/router';
import useBaseUrl from '@docusaurus/useBaseUrl';

// No separate marketing homepage — the root redirects straight to the
// first doc. useBaseUrl matters: this site deploys under /yak-harness/,
// and a hardcoded path would 404 there.
export default function Home(): ReactNode {
  return <Redirect to={useBaseUrl('/docs/why-yak-harness')} />;
}
