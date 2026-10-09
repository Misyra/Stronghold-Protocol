import { html, Button, Modal } from './components.js';
import { APP_VERSION } from '../../../shared/constants.js';
import { t } from '../../../shared/i18n.js';

const REPOSITORY = 'https://github.com/Misyra/Stronghold-Protocol';

export function AboutModal({ open, onClose }) {
  return html`<${Modal} open=${open} title=${t('关于本项目')} micro="STRONGHOLD PROTOCOL · ALLIANCE" width="8rem" class="about-panel"
      onClose=${onClose} actions=${html`<${Button} variant="primary" onClick=${onClose}>${t('关闭')}<//>`}>
      <p class="about-intro">${t('卫戍协议：盟约')} <span class="num">v${APP_VERSION}</span></p>
      <dl class="about-links">
        <div><dt>${t('维护者')}</dt><dd><a href="https://github.com/Misyra" target="_blank" rel="noopener noreferrer">Misyra</a></dd></div>
        <div><dt>${t('联系邮箱')}</dt><dd><a href="mailto:misyra@163.com">misyra@163.com</a></dd></div>
        <div><dt>${t('问题反馈')}</dt><dd><a href=${`${REPOSITORY}/issues`} target="_blank" rel="noopener noreferrer">GitHub Issues</a></dd></div>
        <div><dt>${t('项目仓库')}</dt><dd><a href=${REPOSITORY} target="_blank" rel="noopener noreferrer">Misyra / Stronghold-Protocol</a></dd></div>
      </dl>
      <p>${t('遇到游戏或服务器问题，可通过 GitHub Issues 或邮件联系，反馈时请附上问题描述和截图。')}</p>
      <section class="about-section">
        <h3>${t('版权与免责声明')}</h3>
        <p>${t('本项目是玩家自制的非官方同人作品，仅供学习交流与个人非商业使用，与上海鹰角网络、Yostar 及其关联方没有任何关系，未获其授权或认可。')}</p>
        <p>${t('《明日方舟》及「卫戍协议」相关名称、角色、美术、音乐、音效、文本与数据等素材的版权归原权利人所有。项目代码采用 GPL-3.0-or-later 许可证，游戏素材与数据不在该许可证的授权范围内；第三方库与字体保留各自的许可证。')}</p>
        <p>${t('请勿将游戏素材与数据用于售卖、付费分发、收费开服、广告、打赏、会员等盈利用途。项目按「现状」提供，不提供任何担保；本站无需提供游戏账号或密码。')}</p>
        <p>${t('如权利人认为本项目侵犯其权益，请通过上方邮箱或 Issue 联系，我们会立即删除相关内容。')}</p>
      </section>
      <section class="about-section about-credits">
        <h3>${t('上游与参考来源')}</h3>
        <a href="https://github.com/sganggs/Stronghold-Protocol" target="_blank" rel="noopener noreferrer">sganggs / Stronghold-Protocol</a>
        <a href="https://github.com/xinhai-ai/Stronghold-Protocol" target="_blank" rel="noopener noreferrer">xinhai-ai / Stronghold-Protocol</a>
      </section>
    <//>`;
}
