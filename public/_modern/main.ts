import { mount } from 'svelte';
import ShellMigrationIsland from './ShellMigrationIsland.svelte';

const target = document.createElement('div');
target.id = 'baia-modern-shell-root';
document.body.append(target);

mount(ShellMigrationIsland, { target });
