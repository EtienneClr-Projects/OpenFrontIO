# Master Strategy Guide: Pushing & Retaining Territory in OpenFront.io

Understanding combat resolution, growth mechanics, and defensive structures is crucial for dominating matches in OpenFront.io. Many players experience losing offensive pushes despite having higher overall troop counts because they mismanage population thresholds, ignore defensive infrastructure, or misunderstand how the game calculates combat casualties and speed.

---

## 1. Population Growth Mechanics (The Golden Rule)

The single most critical concept for sustaining offensive pressure and maintaining defense is maintaining the **Optimal Growth Threshold**.

### Maximum Population Scaling
Your maximum troop capacity ($\text{maxPop}$) scales directly with land control and city upgrades:

$$\text{maxPop} = 2 \cdot \left( \text{numTilesOwned}^{0.6} \cdot 1000 + 50000 \right) + (\text{sumOfCityLevels} \cdot 25000)$$

* **Land & Cities:** Each city level adds $+25,000$ max population.
* **Economic Scaling:** Higher maximum capacity allows faster absolute regeneration rates.

### The 42% Peak Growth Rule
Population growth follows a non-linear logistic curve:

$$\text{toAdd} = \left( 10 + \frac{\text{currentPopulation}^{0.73}}{4} \right) \cdot \left( 1 - \frac{\text{currentPopulation}}{\text{maxPopulation}} \right)$$

* **Peak Efficiency:** Peak troop regeneration occurs when your current population sits at **~42.2% of your maximum capacity**.
* **Strategic Implication:**
  * **Hovering near 40%–50%** ensures you generate new troops at the fastest rate possible.
  * **Draining your population below 20–25%** by over-committing to an attack drastically destroys your regeneration rate, leaving you vulnerable to counter-attacks.
  * **Hoarding 100% population** causes growth to drop to zero due to the $(1 - r)$ capacity dampening factor.

---

## 2. Pushing & Offense Strategy

### Combat Resolution & Attrition Factors
When attacking an enemy tile, combat computes troop losses based on terrain, troop density, and fortification status.

1. **Defending Shield Value:** The defender's shield icon represents defending troop density per tile ($\text{Shield} = \text{Defending Troops per Tile} \times 10$).
2. **Terrain Modifiers:**
   * **Plains (Green):** Attacker suffers **10% fewer** casualties; movement speed increased by **+10%**.
   * **Highlands (Hills):** Attacker suffers **10% more** casualties; standard speed.
   * **Mountains (Gray):** Attacker suffers **30% more** casualties; movement speed reduced by **-25%**.

### Attack Processing Speed
Attack speed scales dynamically based on army size ratios and enemy shield density:
* **Overwhelming Force Bonus:** Having an army between $5\times$ and $10\times$ larger than the defender drastically accelerates land expansion rate.
* **Shield Elasticity:** High enemy shield values ($30\text{--}100$) decrease attack speed by up to $0.2\%$ per $1\%$ shield increase.

### Effective Attack Execution
* **Early Game:** Launch attacks using roughly **50% of your maximum population** to rapidly capture territory without stalling regeneration.
* **Mid/Late Game:** Lower attack sizes to **20%–30%** of capacity to maintain continuous push pressure while keeping base reserves above the 42% growth threshold.
* **Hovering & Tooltip Auditing:** Never judge an enemy solely by the shield number on their board. Check their tooltip for **Committed/Offensive Troops**. If an enemy launches a large attack, their defensive shield drops temporarily—making that exact moment the optimal window to strike.

---

## 3. Retaining & Defense Strategy

### Defense Posts (DP)
Defense Posts are the fundamental tool for countering aggressive pushes and holding key chokepoints:

* **Coverage:** 40-tile radius (Euclidean distance).
* **Damage Multiplication:** Increases attacker casualties by **$6\times$ (+500% loss penalty)** for any conquered tile within range.
* **Speed Suppression:** Reduces enemy attack speed by **66%**.
* **Non-Stacking:** Only one Defense Post effect applies per tile at a time.

### Countering & Stopping Enemy Pushes
When an enemy pushes aggressively into your borders:

1. **Do NOT Retaliate Immediately with an Offensive Attack:** 
   * Launching a counter-attack drains your defensive shield density and locks troops into offensive processing, making your home tiles even easier to capture.
2. **Layer Defense Posts in Depth:**
   * Build Defense Posts slightly behind your frontline so they remain active even if the perimeter tiles fall.
   * Forcing the attacker to push through DP range drains their army at $6\times$ normal rates.
3. **The Counter-Strike Window:**
   * Allow the enemy to burn their population down to single-digit percentages against your Defense Posts.
   * Once their push stalls out due to depleted troop reserves, release your stored population to run over their undefended territory.

### Traitor / Betrayal Modifier
* **Penalty:** Betraying an ally flags you as a traitor for **30 seconds**.
* **Effect:** Enemies attacking a traitor lose **50% fewer troops per tile**, causing traitor territory to collapse rapidly under push pressure.

---

## 4. Key Takeaways & Best Practices Checklist

| Phase | Strategic Focus | Action Items |
| :--- | :--- | :--- |
| **Growth Management** | Optimal Regeneration | Keep stored troops around **42% of max population**. Avoid dropping below 25% or sitting at 100%. |
| **Offensive Pushing** | Terrain & Ratio Efficiency | Target Plains over Mountains. Push with army sizes at least $2\times$ to $5\times$ larger than local defender density. |
| **Defensive Holding** | Layered Infrastructure | Construct Defense Posts in depth. Let enemies exhaust their troops before counter-attacking. |
| **Diplomatic Caution** | Betrayal Window | Do not betray unless you can eliminate the target before the 30-second penalty window allows surrounding players to collapse your borders. |
```

### Summary of Key Points
1. **The Math of Growth:** Always aim to keep your active troops around **42% of your Max Population** to maximize passive troop generation rate.
2. **Defense Posts are Essential:** Defending with pure troop density is inefficient against large armies. Defense Posts multiply attacker casualties by $6\times$ and slow down enemy pushes by $66\%$.
3. **Countering Pushes:** Never attack back while being actively pushed; build Defense Posts in depth, let the enemy exhaust their troop supply against your fortifications, and counter-strike when their growth rate collapses.