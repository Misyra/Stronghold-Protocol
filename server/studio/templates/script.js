import { templateFile, localId, jsonText } from '../gameData.js';

export default {
  id: 'script', class: 'script', kinds: [], slots: () => [], overlay: () => ({}),
  build({ id, name }) {
    const replace = text => text.replaceAll('script_demo', localId(id)).replaceAll('script-demo', id);
    const guard = JSON.parse(replace(templateFile('script', 'guard.json')));
    guard.name = name || id;
    return { manifest: { scope: ['room'], permissions: ['sim.code', 'data.add'], operators: ['guard.json'], entry: { sim: 'sim/index.js' } },
      files: { 'guard.json': jsonText(guard), 'sim/index.js': replace(templateFile('script', 'sim/index.js')),
        'test/guard.test.js': replace(templateFile('script', 'test/guard.test.js')) } };
  },
};
