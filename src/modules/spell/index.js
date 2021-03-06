import * as Sentry from '@sentry/node';
import Express from 'express';
import { Sequelize } from 'sequelize';

import BlizzardApi from 'helpers/BlizzardApi';

import models from '../../models';

const Spell = models.Spell;
const DEFAULT_LOCALE = 'en_US'
const REFRESH_INTERVAL = 86400 // no point making this very long, the rate limit is high enough

/**
 * Fetches Spell info(name and icon) from the battle net API.
 * After fetching from API it'll store in MySQL DB in order to reduce the number of calls to the battle net API
 * and reduce latency on subsequent calls
 */

function sendJson(res, json) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.send(json);
}

function send404(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.sendStatus(404);
}

// TODO: Refresh automatically after x time

async function fetchSpell(spellId) {
  const [spellData, spellMediaData] = await Promise.all([
    BlizzardApi.fetchSpell(spellId),
    BlizzardApi.fetchSpellMedia(spellId),
  ]);
  const spell = JSON.parse(spellData);
  const spellMedia = JSON.parse(spellMediaData);

  return {
    spell,
    spellMedia,
  }
}

async function updateSpell(id) {
  try {
    console.log('SPELL', 'Fetching spell', id)
    const { spell, spellMedia } = await fetchSpell(id)
    await Spell.upsert({
      id: id,
      name: JSON.stringify(spell.name),
      icon: spellMedia.assets.find(asset => asset.key === 'icon').value,
      createdAt: Sequelize.fn('NOW'),
    })
  } catch (error) {
    if (error.statusCode === 404) {
      return null
    } else {
      throw error
    }
  }
}

async function getSpell(id) {
  const spell = await Spell.findByPk(id);
  if (spell) {
    const age = (new Date() - spell.createdAt) / 1000
    if (age > REFRESH_INTERVAL) {
      // Background update, show stale data meanwhile (nothing probably changed)
      updateSpell(id)
    }

    return spell
  }

  await updateSpell(id)

  return await Spell.findByPk(id);
}

function sendSpell(res, { id, name, icon }, locale) {
  const nameObject = JSON.parse(name)
  sendJson(res, {
    id,
    name: nameObject[locale] || nameObject[DEFAULT_LOCALE],
    icon,
  })
}

const router = Express.Router();
router.get('/i/spell/:id([0-9]+)', async (req, res) => {
  const { id } = req.params;
  const locale = req.query.locale || DEFAULT_LOCALE
  try {
    let spell = await getSpell(id);
    if (spell) {
      sendSpell(res, spell, locale);
    } else {
      send404(res);
    }
  } catch (error) {
    const { statusCode, message, response } = error;
    console.log('REQUEST', 'Error fetching Spell', statusCode, message);
    const body = response ? response.body : null;
    Sentry.captureException(error);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(statusCode || 500);
    sendJson(res, {
      error: 'Blizzard API error',
      message: body || error.message,
    });
  }
});

export default router;
