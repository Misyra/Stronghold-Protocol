// 战斗 2 倍速的全员投票（g.speedVote，客户端右上角 2X 按钮）：所有连接中的人类玩家都投赞成后，
// 下一场战斗开始时换速度档（原速 GAME_SPEED 2 ⇄ 两倍 SPEED_UP 4）。投票随时可取消（再点一次即撤），
// 全员赞成的判定在换档时点重算——有人撤回就不换。换档只在战斗建立前发生（startCombat / startUnite /
// startFinalAssault 各调用一次 _applySpeedVote），正在进行的战斗不会中途变速。[ASSUMED] 重制版便利，
// 非官方规则（维护者 2026-11-01 拍板）：bot 不能点击、不计票；生效后清空投票，再点即开始反向投票
// （2 倍速中投「恢复原速」）。gameSpeed 只改变推流节奏与各截止期限的实时长度
// （deadline = now + limit/gameSpeed），战斗模拟本身确定性不变（字段推送 speed 即它，客户端本地模拟的
// setLocalFeed 直接跟随）。
import { ERR } from '../../../shared/constants.js';
import { msg } from '../../../shared/i18n.js';
import { GAME_SPEED } from '../fields.js';
import { FLOW_TICKER_PRIORITY, OK, fail } from './common.js';

/** 2 倍速的目标 gameSpeed：基准 2（游戏秒/真实秒）的两倍。 */
export const SPEED_UP = GAME_SPEED * 2;

export class MatchSpeedVote {
  /** g.speedVote {on}: 切换本玩家「换成另一个速度档」的赞成票（原速→2 倍，或 2 倍→原速）。幂等，随时可撤。 */
  speedVote(ps, on) {
    if (this.disposed || this.ended) return fail(ERR.WRONG_PHASE);
    if (!ps || ps.isBot || ps.left || !ps.connected) return fail(ERR.NOT_IN_ROOM);
    const want = on === true;
    const has = this.speedVotes.includes(ps.playerId);
    if (want === has) return OK;
    if (want) this.speedVotes.push(ps.playerId);
    else this.speedVotes = this.speedVotes.filter((id) => id !== ps.playerId);
    const voters = this._speedVoters();
    if (want && voters.length && voters.every((p) => this.speedVotes.includes(p.playerId))) {
      this.tickerText(this.gameSpeed <= GAME_SPEED ? msg('全员同意：下一场战斗起战斗 2 倍速') : msg('全员同意：下一场战斗起恢复原速'), FLOW_TICKER_PRIORITY);
    }
    this.markPublic();
    this.markPrivate(ps); // speedVoted 在私有视图里：不标脏的话客户端按钮的点亮态永远是旧的
    this.flush(true);
    return OK;
  }

  /** 计票对象：每个在线人类席位（阵亡后观战的玩家也能投）；bot 不计。 */
  _speedVoters() { return this.order.filter((p) => !p.isBot && !p.left && p.connected); }

  /** 当前计票对象里已投赞成的席位（离线席位的旧票不显示也不计）。 */
  _speedAgreed() {
    const voters = this._speedVoters();
    return voters.filter((p) => this.speedVotes.includes(p.playerId));
  }

  /** 全员（当前计票对象）都投了赞成。 */
  _unanimous() {
    const voters = this._speedVoters();
    return voters.length > 0 && voters.every((p) => this.speedVotes.includes(p.playerId));
  }

  /**
   * 一场战斗建立前（startCombat / startUnite / startFinalAssault）：全员仍然赞成 → 换速度档（2 倍 ⇄ 原速）
   * 并清空投票；有人撤回就不换。清空后每个人类席位的私有视图都要重发——speedVoted 是按钮的点亮态，阵亡的
   * 投票人不会在 startRound 里被顺带标脏。
   */
  _applySpeedVote() {
    if (this.disposed || this.ended || !this._unanimous()) return;
    this.speedVotes = [];
    this.gameSpeed = this.gameSpeed <= GAME_SPEED ? SPEED_UP : GAME_SPEED;
    for (const p of this.order) if (!p.isBot) this.markPrivate(p);
    this.markPublic();
  }
}
