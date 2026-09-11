import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const root = path.resolve(import.meta.dirname, '..');
const home = path.join(root, 'mix/.key-experiments');
const revision = 'c78e8372e0188c0a11b7b55a653ea0cbbbf70fa5'; // libkeyfinder 2.2.8
const run = (file: string, args: string[]) => execFileSync(file, args, {cwd:root,stdio:'inherit',env:{...process.env,UV_CACHE_DIR:path.join(home,'uv-cache')}});
await fs.mkdir(home,{recursive:true});
let failures = 0;
try {
  const source = path.join(home,'libkeyfinder-source'), build = path.join(home,'build'), prefix = path.join(home,'prefix');
  try { await fs.access(path.join(source,'.git')); } catch { run('git',['clone','https://github.com/mixxxdj/libkeyfinder.git',source]); }
  run('git',['-C',source,'checkout','--detach',revision]);
  run('cmake',['-S',source,'-B',build,`-DCMAKE_INSTALL_PREFIX=${prefix}`,'-DBUILD_TESTING=OFF','-DBUILD_SHARED_LIBS=OFF','-DCMAKE_BUILD_TYPE=Release']);
  run('cmake',['--build',build,'--parallel','2']); run('cmake',['--install',build]);
  const fftw = execFileSync('pkg-config',['--cflags','--libs','fftw3'],{encoding:'utf8'}).trim().split(/\s+/);
  run('clang++',['-std=c++11','-O2',path.join(root,'mix/native/keyfinder.cpp'),`-I${prefix}/include`,path.join(prefix,'lib/libkeyfinder.a'),...fftw,'-o',path.join(home,'keyfinder')]);
} catch (error) { failures++; console.error('libkeyfinder unavailable: install cmake, pkg-config, FFTW3 and a C++ compiler, then retry.', String(error)); }
try {
  const python = path.join(home,'venv/bin/python');
  try { await fs.access(python); } catch { run('uv',['venv','--python','3.14',path.join(home,'venv')]); }
  run('uv',['pip','install','--python',python,'--only-binary=:all:','essentia==2.1b6.dev1438','numpy==2.4.3','six==1.17.0','pyyaml==6.0.3']);
  run(python,[path.join(root,'mix/experiments/key/essentia_worker.py'),'--version']);
  const freeze = execFileSync('uv',['pip','freeze','--python',python],{encoding:'utf8',env:{...process.env,UV_CACHE_DIR:path.join(home,'uv-cache')}});
  await fs.writeFile(path.join(home,'python-freeze.txt'),freeze);
} catch (error) { failures++; console.error('Essentia unavailable: requires uv and a compatible Python 3.14 binary wheel (Mac macOS15+). No source-build fallback.',String(error)); }
console.log(`Isolated experiment tools: ${home}. ${failures} backend setup failure(s). No app restart or library analysis performed.`);
process.exitCode = failures ? 1 : 0;
