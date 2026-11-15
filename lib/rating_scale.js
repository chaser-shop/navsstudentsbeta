'use strict';
/**
 * Rating Scale and Grading Engine for NAVS Electronic Diary.
 * 
 * Офіційна шкала оцінювання:
 *  - 89–100  → 5   (Відмінно)
 *  - 82–88   → 4+  (Добре з плюсом)
 *  - 75–81   → 4   (Добре)
 *  - 64–74   → 3   (Задовільно)
 *  - 60–63   → 3-  (Задовільно з мінусом)
 *  - < 60    → 2   (Не досягнуто мінімального порогу)
 * 
 * Нормалізація:
 *  (Набрані бали / Максимально можливі бали) × 100
 */

/**
 * Нормалізує набрані бали відносно максимальних.
 * @param {number} earned - Набрані бали
 * @param {number} max - Максимально можливі бали
 * @returns {number|null} Нормалізовані бали від 0 до 100
 */
function normalizeScore(earned, max) {
  if (earned == null || isNaN(earned)) return null;
  const numEarned = Number(earned);
  const numMax = Number(max);
  if (numMax <= 0 || isNaN(numMax)) return Math.min(100, Math.max(0, numEarned));
  const normalized = (numEarned / numMax) * 100;
  return Math.round(normalized * 10) / 10;
}

/**
 * Визначає підсумкову оцінку за 100-бальною шкалою (після обов'язкової нормалізації).
 * @param {number} score - Бали (0..100)
 * @returns {object|null} { grade, label, badge, isPassed, score }
 */
function gradeFromScore(score) {
  if (score == null || isNaN(score)) return null;
  const s = Math.round(Number(score) * 10) / 10;
  if (s >= 89) {
    return { grade: '5', label: 'Відмінно', badge: 'grade-5', isPassed: true, score: s };
  }
  if (s >= 82) {
    return { grade: '4+', label: 'Добре+', badge: 'grade-4plus', isPassed: true, score: s };
  }
  if (s >= 75) {
    return { grade: '4', label: 'Добре', badge: 'grade-4', isPassed: true, score: s };
  }
  if (s >= 64) {
    return { grade: '3', label: 'Задовільно', badge: 'grade-3', isPassed: true, score: s };
  }
  if (s >= 60) {
    return { grade: '3-', label: 'Задовільно-', badge: 'grade-3minus', isPassed: true, score: s };
  }
  return { grade: '2', label: 'Не досягнуто мінімуму', badge: 'grade-2', isPassed: false, score: s };
}

/**
 * Обчислює підсумковий результат студента за списком предметів з урахуванням нормалізації.
 * @param {Array<{ key: string, score: number, max: number }>} subjects
 */
function aggregateStudentRating(subjects = []) {
  let totalEarned = 0;
  let totalMax = 0;
  let countedCount = 0;

  for (const s of subjects) {
    if (s && s.score != null && !isNaN(s.score)) {
      totalEarned += Number(s.score);
      totalMax += Number(s.max || 100);
      countedCount++;
    }
  }

  if (countedCount === 0 || totalMax <= 0) {
    return {
      totalEarned: 0,
      totalMax: 0,
      normalized: 0,
      gradeInfo: null,
      percentage: 0,
    };
  }

  const normalized = normalizeScore(totalEarned, totalMax);
  const gradeInfo = gradeFromScore(normalized);

  return {
    totalEarned: Math.round(totalEarned * 10) / 10,
    totalMax: Math.round(totalMax * 10) / 10,
    normalized,
    gradeInfo,
    percentage: normalized,
  };
}

module.exports = {
  normalizeScore,
  gradeFromScore,
  aggregateStudentRating,
};
