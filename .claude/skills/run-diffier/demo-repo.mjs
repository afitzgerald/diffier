// Builds a small, deterministic git repo with a realistic mixed changeset
// (modified/added/deleted/untracked files) for screenshots and manual QA.
// Usage: node demo-repo.mjs <target-dir>
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node demo-repo.mjs <target-dir>');
  process.exit(1);
}

const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
const write = (rel, content) => fs.writeFileSync(path.join(dir, rel), content);

fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(path.join(dir, 'src/components'), { recursive: true });
fs.mkdirSync(path.join(dir, 'src/util'), { recursive: true });

git('init', '-q');
git('config', 'user.email', 'you@example.com');
git('config', 'user.name', 'Demo');

write(
  'src/components/Button.jsx',
  `import React from 'react';

export function Button({ label, onClick }) {
  return (
    <button className="btn" onClick={onClick}>
      {label}
    </button>
  );
}

export function IconButton({ icon, onClick }) {
  return (
    <button className="icon-btn" onClick={onClick}>
      {icon}
    </button>
  );
}
`
);
write(
  'src/util/format.js',
  `export function formatBytes(n) {
  return \`\${n} B\`;
}
`
);
write('src/index.js', `export * from './components/Button.jsx';\n`);
git('add', '-A');
git('commit', '-qm', 'Initial commit');

// Working-tree changes: one edited component, one added component, an
// edited util, a deleted (unstaged) file, and an untracked README —
// exercises every VCS-status color the Changes tree renders.
write(
  'src/components/Button.jsx',
  `import React from 'react';

export function Button({ label, onClick, variant = 'primary' }) {
  return (
    <button className={'btn btn-' + variant} onClick={onClick}>
      {label}
    </button>
  );
}

export function IconButton({ icon, onClick, title }) {
  return (
    <button className="icon-btn" title={title} onClick={onClick}>
      {icon}
    </button>
  );
}
`
);
write(
  'src/components/Card.jsx',
  `import React from 'react';

export function Card({ children }) {
  return <div className="card">{children}</div>;
}
`
);
write(
  'src/util/format.js',
  `export function formatBytes(n) {
  if (n < 1024) return \`\${n} B\`;
  return \`\${(n / 1024).toFixed(1)} KB\`;
}
`
);
fs.rmSync(path.join(dir, 'src/index.js'));
write('README.md', `# acme-app\n\nA small demo app.\n`);

console.log('demo repo ready at', dir);
