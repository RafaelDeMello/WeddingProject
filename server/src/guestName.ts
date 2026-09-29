import { z } from 'zod';

export const GUEST_NAME_MAX = 40;

// Caracteres de controle, espaços de largura zero, BOM e overrides de direção de texto.
// O ZWJ (U+200D) fica: ele compõe emojis como 👨‍👩‍👧.
const INVISIBLE = /[\p{Cc}​‪-‮⁦-⁩﻿]/gu;

const length = (v: string) => [...v].length;

export const guestNameSchema = z
  .string({ error: 'Informe seu nome.' })
  .max(500, 'Nome longo demais.')
  .transform((v) => v.replace(INVISIBLE, '').replace(/\s+/gu, ' ').trim().normalize('NFC'))
  .refine((v) => length(v) >= 1, 'Informe seu nome.')
  .refine((v) => length(v) <= GUEST_NAME_MAX, `Use no máximo ${GUEST_NAME_MAX} caracteres.`);
