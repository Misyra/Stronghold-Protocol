import meta from './meta.js';
import { buildOperator } from './operator.js';
import { dslExample } from '../dslExamples.js';

export default {
  id: 'dsl', class: 'content', kinds: ['operator'], slots: () => [], overlay: () => ({}),
  build(args) {
    const example = args.options.example || 'skgoat';
    const start = dslExample(example, args.id);
    if (start.spec.meta) return meta.build(args);
    return buildOperator({ ...args, target: { key: start.charId || 'char_102_texas' },
      options: { ...args.options, kitSource: 'dsl', dsl: args.options.dsl || start.spec } });
  },
};
