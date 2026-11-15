'use strict';
/**
 * Role-Based Access Control (RBAC) with Per-Group Starostas.
 * 
 * Ролі:
 *  - admin: Головний адміністратор (глобальний доступ до всіх груп та налаштувань)
 *  - starosta: Староста (повні права керування у межах своєї групи)
 *  - deputy: Заступник старости (права помічника старости у межах своєї групи)
 *  - student: Студент (звичайний учасник групи)
 * 
 * КРИТИЧНА ВИМОГА:
 * Староста та заступник мають права модерації ВИКЛЮЧНО для своєї групи.
 * Будь-які спроби керувати іншими групами блокуються на сервері (HTTP 403).
 */

const { HttpError } = require('./util');

const ROLE_TITLES = {
  admin: 'Головний адміністратор',
  starosta: 'Староста',
  deputy: 'Заступник старости',
  student: 'Студент',
};

/**
 * Перевіряє, чи є користувач глобальним адміністратором.
 */
function isAdmin(user) {
  return !!(user && (user.isAdmin || user.role === 'admin'));
}

/**
 * Перевіряє, чи є користувач старостою або заступником старости СВОЄЇ групи.
 */
function isGroupLeader(user, groupName) {
  if (!user) return false;
  if (isAdmin(user)) return true;
  if (user.role === 'starosta' || user.role === 'deputy') {
    if (!groupName) return true;
    return String(user.group || '').toLowerCase() === String(groupName || '').toLowerCase();
  }
  return false;
}

/**
 * Перевіряє права доступу користувача до цільової групи.
 * Кидає HttpError(403), якщо користувач не має прав.
 */
function assertGroupAccess(user, targetGroup, { requireLeader = false } = {}) {
  if (!user) throw new HttpError(401, 'Потрібна авторизація.');
  if (isAdmin(user)) return true;

  const userGroup = String(user.group || '').trim().toLowerCase();
  const target = String(targetGroup || '').trim().toLowerCase();

  if (userGroup !== target) {
    throw new HttpError(403, `У вас немає доступу до навчальної групи «${targetGroup}». Дозволено лише для вашої групи «${user.group || 'не вказано'}».`);
  }

  if (requireLeader) {
    if (user.role !== 'starosta' && user.role !== 'deputy') {
      throw new HttpError(403, 'Ця дія доступна лише старості або заступнику вашої групи.');
    }
  }

  return true;
}

/**
 * Перевіряє права модерації для домашнього завдання або розкладу.
 */
function canModerateResource(user, resourceGroup) {
  if (!user) return false;
  if (isAdmin(user)) return true;
  if (user.role === 'starosta' || user.role === 'deputy') {
    if (!resourceGroup) return true;
    return String(user.group || '').toLowerCase() === String(resourceGroup || '').toLowerCase();
  }
  return false;
}

module.exports = {
  ROLE_TITLES,
  isAdmin,
  isGroupLeader,
  assertGroupAccess,
  canModerateResource,
};
