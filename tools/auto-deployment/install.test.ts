import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const installer = pathToFileURL(resolve('tools/auto-deployment/install.mjs')).href;
function evaluate(expression: string): unknown {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import * as installer from ${JSON.stringify(installer)}; console.log(JSON.stringify(${expression}));`,
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout) as unknown;
}

describe('controller installer validation', () => {
  it('accepts explicit preparation and full-enable arguments', () => {
    expect(
      evaluate(`installer.parseInstallArguments(['operator','/srv/pleiades','--prepare'])`),
    ).toEqual({ user: 'operator', source: '/srv/pleiades', prepareOnly: true });
    expect(evaluate(`installer.parseInstallArguments(['operator','/srv/pleiades'])`)).toEqual({
      user: 'operator',
      source: '/srv/pleiades',
      prepareOnly: false,
    });
  });

  it.each([
    ['root', '/srv/pleiades'],
    ['operator', 'relative'],
    ['operator', '/srv/../etc'],
    ['operator', '/srv/pleiades', '--unknown'],
    ['operator', '/srv/pleiades', '--prepare', 'extra'],
    ['operator\nUser=root', '/srv/pleiades'],
    ['operator', '/srv/pleiades\n'],
    [],
  ])('rejects invalid installer arguments: %j', (...args) => {
    expect(
      evaluate(
        `(() => { try { installer.parseInstallArguments(${JSON.stringify(args)}); return false; } catch { return true; } })()`,
      ),
    ).toBe(true);
  });

  it('retains the operator primary group when adding settings access', () => {
    expect(evaluate(`installer.operatorIdentityArguments('operator','operators',true)`)).toEqual([
      '-u',
      'operator',
      '--group',
      'operators',
      '--supp-group',
      'pleiades-settings',
    ]);
  });

  it('prepares the controller before the settings group exists', () => {
    expect(evaluate(`installer.operatorIdentityArguments('operator','operators',false)`)).toEqual([
      '-u',
      'operator',
      '--group',
      'operators',
    ]);
  });

  it('pins every executable and working-directory reference to the validated immutable snapshot', () => {
    const snapshot = '/opt/pleiades-auto-deploy/releases/123-456';
    const units = evaluate(
      `installer.renderControllerUnits('operator','/home/operator',${JSON.stringify(snapshot)})`,
    ) as Record<string, string>;
    expect(units['pleiades-auto-deploy.service']).toContain(`WorkingDirectory=${snapshot}`);
    expect(units['pleiades-auto-deploy.service']).toContain(
      `Environment=TS_NODE_PROJECT=${snapshot}/tsconfig.json`,
    );
    expect(units['pleiades-auto-deploy.service']).toContain(
      `ExecStart=${snapshot}/runtime/bin/node -r ts-node/register ${snapshot}/scripts/auto-deploy.ts poll /etc/pleiades-auto-deploy.json`,
    );
    expect(units['pleiades-auto-deploy.service']).not.toContain('/current');
    expect(units['pleiades-auto-deploy.timer']).toContain('WantedBy=timers.target');
  });

  it.each([
    '/tmp/arbitrary',
    '/opt/pleiades-auto-deploy/releases/../current',
    '/opt/pleiades-auto-deploy/releases/1-2\nUser=root',
    '/opt/pleiades-auto-deploy/releases/1-2/extra',
  ])('rejects unsafe snapshot references: %s', (snapshot) => {
    expect(
      evaluate(
        `(() => { try { installer.renderControllerUnits('operator','/home/operator',${JSON.stringify(snapshot)}); return false; } catch { return true; } })()`,
      ),
    ).toBe(true);
  });
});

const transactionHarness = (
  failure: string,
  prepareOnly = false,
  rollbackFailure = '',
): string => `(() => {
  const original = { current:'old', units:'old', enabled:true, active:true };
  const state = { ...original };
  const trace = [];
  let failed = false;
  const step = (name, effect = () => {}) => {
    trace.push(name); effect();
    if (name === ${JSON.stringify(failure)} && !failed) { failed=true; throw new Error('activation failed'); }
    if (name === ${JSON.stringify(rollbackFailure)}) throw new Error('restoration failed');
  };
  const operations = {
    capture() { step('capture'); return { ...state }; },
    stopTimer() { step('stop', () => { state.active=false; }); },
    assertIdle() { step('idle'); },
    publish() { step('publish', () => { state.current='new'; }); },
    installUnits() { step('units', () => { state.units='new'; }); },
    reload() { step('reload'); },
    configureTimer(prepare) { step(prepare ? 'disable' : 'enable', () => { state.enabled=!prepare; state.active=!prepare; }); },
    quiesceTimer() { step('quiesce', () => { state.enabled=false; state.active=false; }); },
    restoreCurrent(previous) { step('restore-current', () => { state.current=previous.current; }); },
    restoreUnits(previous) { step('restore-units', () => { state.units=previous.units; }); },
    restoreTimer(previous) { step('restore-timer', () => { state.enabled=previous.enabled; state.active=previous.active; }); },
  };
  let error;
  try { installer.activateController(operations, ${prepareOnly}); } catch (caught) { error = { name:caught.name, count:caught.errors?.length || 0 }; }
  return { original,state,trace,error };
})()`;

describe('controller installer activation transaction', () => {
  it('installs a prepared snapshot and enables the timer only after publication and reload', () => {
    expect(evaluate(transactionHarness(''))).toEqual({
      original: { current: 'old', units: 'old', enabled: true, active: true },
      state: { current: 'new', units: 'new', enabled: true, active: true },
      trace: ['capture', 'stop', 'idle', 'publish', 'units', 'reload', 'enable'],
    });
  });

  it('explicitly disables an already enabled timer in preparation mode', () => {
    const result = evaluate(transactionHarness('', true)) as { state: unknown; trace: string[] };
    expect(result.state).toEqual({ current: 'new', units: 'new', enabled: false, active: false });
    expect(result.trace.at(-1)).toBe('disable');
  });

  it.each(['publish', 'units', 'reload', 'enable'])(
    'restores previous current, unit contents and timer state after partial %s failure',
    (failure) => {
      const result = evaluate(transactionHarness(failure)) as {
        original: unknown;
        state: unknown;
        trace: string[];
        error: unknown;
      };
      expect(result.state).toEqual(result.original);
      expect(result.trace.slice(-5)).toEqual([
        'quiesce',
        'restore-current',
        'restore-units',
        'reload',
        'restore-timer',
      ]);
      expect(result.error).toEqual({ name: 'Error', count: 0 });
    },
  );

  it('restores timer state without publishing when a deployment is still running', () => {
    const result = evaluate(transactionHarness('idle')) as {
      original: unknown;
      state: unknown;
      trace: string[];
    };
    expect(result.state).toEqual(result.original);
    expect(result.trace).toEqual(['capture', 'stop', 'idle', 'quiesce', 'restore-timer']);
  });

  it('keeps deployment disabled and reports restoration errors instead of restarting mixed state', () => {
    const result = evaluate(transactionHarness('enable', false, 'restore-units')) as {
      state: { enabled: boolean; active: boolean };
      trace: string[];
      error: unknown;
    };
    expect(result.state.enabled).toBe(false);
    expect(result.state.active).toBe(false);
    expect(result.trace).not.toContain('restore-timer');
    expect(result.error).toEqual({ name: 'AggregateError', count: 2 });
  });
});
