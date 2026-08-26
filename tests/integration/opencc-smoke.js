#!/usr/bin/gjs -m

import {LyricsScriptConverter} from '../../dist/lyrics/script.js';

const converter = new LyricsScriptConverter();
const simplified = await converter.convertText('當你再次和我說起 洋蔥', 'simplified');
const traditional = await converter.convertText('当你再次和我说起 洋葱', 'traditional');

if (simplified !== '当你再次和我说起 洋葱')
    throw new Error(`Unexpected Simplified Chinese output: ${simplified}`);
if (traditional !== '當你再次和我說起 洋蔥')
    throw new Error(`Unexpected Traditional Chinese output: ${traditional}`);

console.log('LyricFlow OpenCC smoke test passed');
