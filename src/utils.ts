import { promisify } from 'util';
import { exec as nodeExec } from 'child_process';

export const sleep = promisify(setTimeout);

export const exec = promisify(nodeExec);
