/** 业务实现聚合出口：impl* 供 CLI 与其它模块调用 */
import { runLogin } from './login.js';
import { runGetCandidateList } from './list.js';
import { runListOpenPositions } from './jd.js';
import { runOpenCandidateChat, runOpenCandidateChatByIndex } from './chat.js';
import {
  runChatActionOnCurrentConversation,
  type ChatPageAction,
} from './action.js';
import { runSendChatMessage } from './send.js';
import { withBossSessionPage } from '../common/boss_session_page.js';
import { runBossSearch, runBossSearchSet } from './deep-search.js';
import { runNormalSearch } from './normal-search.js';
import { runRecommend } from './recommend.js';
import { runPreview } from './preview.js';
import { runRecommendGreet, type GreetOptions } from './greet.js';
export type { ChatPageAction };
export type { DeepSearchGeekItem } from './deep-search.js';

export async function implLogin(): Promise<string> {
  return runLogin();
}

export async function implListCandidates(): Promise<string> {
  return runGetCandidateList();
}

export async function implListUnreadCandidates(): Promise<string> {
  return runGetCandidateList({ unreadOnly: true });
}

export async function implOpenChat(
  candidateName: string,
  exact: boolean,
): Promise<string> {
  return withBossSessionPage(async (page) => runOpenCandidateChat(page, candidateName, exact));
}

export async function implOpenChatByIndex(params: {
  index: number;
  unreadOnly?: boolean;
  expectedName?: string;
  exact?: boolean;
}): Promise<string> {
  return withBossSessionPage(async (page) =>
    runOpenCandidateChatByIndex(page, {
      index: params.index,
      filter: params.unreadOnly ? 'unread' : 'all',
      expectedName: params.expectedName,
      exact: params.exact,
    }),
  );
}

export async function implChatAction(params: {
  action: ChatPageAction;
  remark?: string;
}): Promise<string> {
  return withBossSessionPage(async (page) => runChatActionOnCurrentConversation(page, params));
}

export async function implSendMessage(params: {
  text: string;
  requestResume?: boolean;
}): Promise<string> {
  return runSendChatMessage({
    text: params.text || undefined,
    requestResume: params.requestResume,
  });
}

export async function implListPositions(): Promise<string> {
  return runListOpenPositions();
}

export async function implListPositionsWithOptions(opts: {
  detail?: boolean;
  name?: string;
}): Promise<string> {
  return runListOpenPositions({
    detail: opts.detail,
    detailName: opts.name,
  });
}

export async function implBossSearch(
  opts: {
    jobKeyword?: string;
    coreRequirements?: string[];
    bonusRequirements?: string[];
    match?: boolean;
  } = {},
): Promise<string> {
  return runBossSearch(opts);
}

export async function implNormalSearch(keyword?: string): Promise<string> {
  return runNormalSearch(keyword);
}

export async function implBossSearchSet(opts: {
  jobKeyword?: string;
  coreRequirements?: string[];
  bonusRequirements?: string[];
}): Promise<string> {
  return runBossSearchSet(opts);
}

export async function implRecommend(jobKeyword?: string): Promise<string> {
  return runRecommend(jobKeyword);
}

export async function implPreview(opts: {
  candidateTarget: string;
}): Promise<string> {
  return runPreview(opts);
}

// 直接复用 GreetOptions，不再在这里重抄一份字段：原先是内联字面量类型，
// greet.ts 加了 expectGeekId 之后这层没同步，调用方传新字段会被 TS 拒绝。
export async function implRecommendGreet(opts: GreetOptions): Promise<string> {
  return runRecommendGreet(opts);
}

export { implSetBaiduCredentials } from './baidu_credentials.js';
