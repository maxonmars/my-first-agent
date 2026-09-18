import { Invariant } from "./invariants.ts";

// Учебные эвристики для русского текста: распознают перечисленные в README формы, а не любые перефразировки.
// \b в JavaScript не видит кириллицу, поэтому границы слова заданы через \p{L}\p{N}.
function words(alternatives: readonly string[]): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives.join("|")})(?![\\p{L}\\p{N}])`, "giu");
}

const WORD = /[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu;
const SENTENCE_BREAK = /[.!?…]+(?=\s|$)|[;\n]+/u;
const CLAUSE_BREAK = /[,:()]|\s[—–-]\s/u;
const PLEASE = /,?\s*пожалуйста(?![\p{L}\p{N}])\s*,?/giu;
const NEGATION = /(?<![\p{L}\p{N}])(?:не|нельзя|ни|нет|никогда|невозможно)(?![\p{L}\p{N}])/iu;
const NEGATED_MODAL =
  /(?<![\p{L}\p{N}])(?:нельзя|невозможно|не\s+(?:могу|можем|сможем|вправе|стану|станем|буду|будем|имею|имеем|получится|уполномочен\p{L}*))(?![\p{L}\p{N}])/iu;
const SUBORDINATE = /^\s*(?:что|чтобы|будто|якобы)(?![\p{L}\p{N}])/iu;
const CONTRAST = /^\s*(?:но|однако|зато|а)(?![\p{L}\p{N}])/iu;
const PREPOSITION = /(?<![\p{L}\p{N}])(?:о|об|обо|по|про|на|в|во|за|для|от|из|с|со|к|ко|у|насч[её]т)(?![\p{L}\p{N}])/iu;

export function countWords(text: string): number {
  return text.match(WORD)?.length ?? 0;
}

/**
 * Утверждает ли текст «action … object» в одной части предложения. Не считаются: отрицание перед action,
 * отрицаемая модальность в части («не могу», «нельзя») и придаточное «что …» после отрицаемой главной части до «но».
 * maxGap ограничивает число слов между action и object; при ограничении между ними не должно быть предлогов.
 */
function affirms(text: string, action: RegExp, object: RegExp, maxGap = Number.POSITIVE_INFINITY): boolean {
  for (const sentence of text.split(SENTENCE_BREAK)) {
    let negatedScope = false;
    let previousNegated = false;
    for (const clause of sentence.replace(PLEASE, " ").split(CLAUSE_BREAK)) {
      if (CONTRAST.test(clause)) negatedScope = false;
      else if (previousNegated && SUBORDINATE.test(clause)) negatedScope = true;
      previousNegated = NEGATION.test(clause);
      if (negatedScope || NEGATED_MODAL.test(clause)) continue;

      for (const verb of clause.matchAll(action)) {
        if (NEGATION.test(clause.slice(0, verb.index))) continue;
        for (const target of clause.matchAll(object)) {
          const gap =
            target.index >= verb.index
              ? clause.slice(verb.index + verb[0].length, target.index)
              : clause.slice(target.index + target[0].length, verb.index);
          if (NEGATION.test(gap)) continue;
          if (maxGap === Number.POSITIVE_INFINITY || (countWords(gap) <= maxGap && !PREPOSITION.test(gap))) return true;
        }
      }
    }
  }
  return false;
}

const DELIVERY_PROMISE = words([
  "гарантиру\\p{L}*",
  "(?:по)?обеща\\p{L}*",
  "обязуемся",
  "достав(?:им|ят|ит|лю)",
  "привез(?:[её]м|ут|[её]т|у)",
  "(?:будет|будут)\\s+(?:\\p{L}+\\s+)?доставлен\\p{L}*",
  "доставлен\\p{L}*\\s+(?:будет|будут)",
  "(?:заказ|посылк|товар|покупк|курьер)\\p{L}*\\s+(?:\\p{L}+\\s+)?(?:прид[её]т|прибуд[её]т|приедет)",
  "(?:прид[её]т|прибуд[её]т|приедет)\\s+(?:\\p{L}+\\s+)?(?:заказ|посылк|товар|покупк|курьер)\\p{L}*",
  "будет\\s+у\\s+вас",
  "получите\\s+(?:(?:свой|ваш)\\s+)?(?:заказ|посылк|товар|покупк)\\p{L}*",
  "доставка\\s+(?:будет|состоится|ожидается|запланирована|назначена)",
]);

const EXACT_TIME = words([
  "сегодня",
  "завтра",
  "послезавтра",
  "\\d{1,2}\\s+(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)",
  "\\d{1,2}\\.\\d{1,2}(?:\\.\\d{2,4})?",
  "во?\\s+(?:понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье)",
  "(?:через|в\\s+течение|за)\\s+\\d+(?:\\s*[-–]\\s*\\d+)?\\s+(?:рабоч\\p{L}*\\s+)?(?:час|дн|день|сут|недел)\\p{L}*",
  "(?:через|в\\s+течение)\\s+(?:час|сутки|суток|неделю|недели)",
  "на\\s+(?:этой|следующей)\\s+неделе",
  "до\\s+(?:конца\\s+(?:дня|недели)|\\d{1,2}(?::\\d{2})?)",
]);

const COMPENSATION_PROMISE = words([
  "выплат(?:им|ят|ит)",
  "выплачу",
  "верн(?:[её]м|ут|[её]т|у)(?:ся)?",
  "возмест(?:им|ят|ит)",
  "возмещу",
  "компенсиру(?:ем|ют|ет|ю)",
  "предостав(?:им|ят|ит|лю)",
  "начисл(?:им|ят|ит)",
  "перечисл(?:им|ят|ит)",
  "оформ(?:им|ят)",
  "дад(?:им|ут)",
  "сдела(?:ем|ют)",
  "получите",
  "(?:будет|будут)\\s+(?:выплачен|возвращ[её]н|компенсирован|предоставлен|начислен|перечислен)\\p{L}*",
  "гарантиру(?:ем|ю)",
  "(?:по)?обеща(?:ем|ю)",
]);

const COMPENSATION = words([
  "компенсаци\\p{L}*",
  "скидк\\p{L}*",
  "возврат\\p{L}*",
  "деньг\\p{L}*",
  "денег",
  "средств\\p{L}*",
  "стоимост\\p{L}*",
  "бонус\\p{L}*",
  "балл\\p{L}*",
  "промокод\\p{L}*",
  "к[эе]шб[эе]к\\p{L}*",
  "(?:\\d[\\d\\s]*)?(?:рубл\\p{L}*|руб)",
  "\\d[\\d\\s]*(?:₽|%)",
]);

const DATA_REQUEST = words([
  "пришлите",
  "пришли",
  "присылайте",
  "вышлите",
  "отправьте",
  "отправь",
  "перешлите",
  "скиньте",
  "сообщите",
  "сообщи",
  "назовите",
  "назови",
  "укажите",
  "укажи",
  "напишите",
  "напиши",
  "продиктуйте",
  "продиктуй",
  "предоставьте",
  "дайте",
  "уточните",
  "нуж(?:ен|на|но|ны)",
  "понадоб(?:ится|ятся)",
  "потребу(?:ется|ются)",
  "требуется",
  "необходим[аоы]?",
  "просим",
  "прошу",
  "попрошу",
  "попросим",
  "запрашиваем",
  "запросим",
  "запрошу",
]);

const PAYMENT_SECRET = words([
  "cvv2?",
  "cvc2?",
  "код\\p{L}*\\s+безопасности",
  "(?:pin|пин)(?:[-\\s]?код\\p{L}*)?",
  "(?:код\\p{L}*|парол\\p{L}*)\\s+из\\s+(?:sms|смс|сообщени\\p{L}*)",
  "(?:sms|смс)[-\\s]?(?:код\\p{L}*|парол\\p{L}*)",
  "код\\p{L}*\\s+подтверждени\\p{L}*",
  "одноразов\\p{L}*\\s+(?:код\\p{L}*|парол\\p{L}*)",
  // «последние 4 цифры номера карты» и карта лояльности — не полный номер банковской карты.
  "(?<!цифр\\p{L}*\\s+)номер\\p{L}*\\s+(?:(?:ваш|сво|банковск|платёжн|платежн|кредитн|дебетов)\\p{L}*\\s+)*карт\\p{L}*(?!\\s+лояльност)",
  "(?:16|шестнадцать)\\s+цифр\\p{L}*",
]);

export class NoUnconfirmedDeadline extends Invariant {
  constructor() {
    super(
      "NoUnconfirmedDeadline",
      "Не обещать и не называть как решённый точный срок доставки (сегодня, завтра, дату или число дней), пока он не подтверждён.",
    );
  }

  check(response: string): boolean {
    return !affirms(response, DELIVERY_PROMISE, EXACT_TIME);
  }
}

export class NoCompensationPromise extends Invariant {
  constructor() {
    super(
      "NoCompensationPromise",
      "Не обещать от имени магазина возврат денег, скидку или компенсацию: такое решение принимает не ассистент.",
    );
  }

  check(response: string): boolean {
    return !affirms(response, COMPENSATION_PROMISE, COMPENSATION, 2);
  }
}

export class NoPaymentCredentialsRequest extends Invariant {
  constructor() {
    super(
      "NoPaymentCredentialsRequest",
      "Не запрашивать у клиента полный номер банковской карты, CVV/CVC, PIN или код из SMS.",
    );
  }

  check(response: string): boolean {
    return !affirms(response, DATA_REQUEST, PAYMENT_SECRET);
  }
}

export class MaxWordsInvariant extends Invariant {
  readonly maxWords: number;

  constructor(maxWords: number) {
    if (!Number.isSafeInteger(maxWords) || maxWords <= 0) {
      throw new RangeError("maxWords должен быть положительным безопасным целым числом.");
    }
    super("MaxWordsInvariant", `Ответ пользователю — не больше ${maxWords} слов.`);
    this.maxWords = maxWords;
  }

  check(response: string): boolean {
    return countWords(response) <= this.maxWords;
  }
}

export const SUPPORT_INVARIANTS: readonly Invariant[] = Object.freeze(
  [
    new NoUnconfirmedDeadline(),
    new NoCompensationPromise(),
    new NoPaymentCredentialsRequest(),
    new MaxWordsInvariant(120),
  ].map((invariant) => Object.freeze(invariant)),
);
