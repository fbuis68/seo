(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SesameROI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const moduleData = {
    checkin: { label: 'Digital check-in', min: 8 }, id: { label: 'Contrôle d’identité', min: 3 },
    tax: { label: 'Taxe de séjour', min: 4 }, sms: { label: 'SMS automatisés', min: 2 },
    room: { label: 'Room service', min: 3 }, requests: { label: 'Gestion des demandes', min: 3 },
    eco: { label: 'Sesame Éco', min: 0 }, wallet: { label: 'Wallet', min: 1 },
    book: { label: 'Livret d’accueil', min: 2 }, group: { label: 'Accueil de groupe', min: 5 }
  };
  const environmentalData = {
    waterLitersPerAcceptedStay: 5,
    vacuumKwh: 0.55 * 2,
    washingKwh: 85 / 198,
    dryingKwh: 180 / 198,
    frenchElectricityKgCo2ePerKwh: 0.029
  };
  environmentalData.co2KgPerAcceptedStay = (environmentalData.vacuumKwh + environmentalData.washingKwh + environmentalData.dryingKwh) * environmentalData.frenchElectricityKgCo2ePerKwh;

  function calculate(options) {
    const modules = Array.isArray(options.modules) ? options.modules : [];
    const accessCount = Math.max(0, Number(options.accessCount) || 0);
    if (accessCount > 0) {
      const usesPerDay = Math.max(0, Number(options.usesPerDay) || 2);
      const minutesPerUse = Math.max(0, Number(options.minutesPerUse) || 5);
      const includeAccess = options.includeAccess !== false;
      const includeEco = Boolean(options.includeEco);
      const accessOccupancyPercent = Math.max(0, Math.min(100, Number(options.accessOccupancyPercent) || 70));
      const accessOperations = includeAccess ? accessCount * (accessOccupancyPercent / 100) * usesPerDay * 365 : 0;
      const averageStayNights = 3;
      const ecoRoomCount = Math.max(0, Number(options.ecoRoomCount) || 50);
      const ecoOccupancyPercent = 80;
      const ecoAcceptancePercent = 25;
      const ecoPotentialStays = includeEco ? ecoRoomCount * (ecoOccupancyPercent / 100) * 365 / averageStayNights : 0;
      const ecoAnnualStays = ecoPotentialStays * (ecoAcceptancePercent / 100);
      const ecoOptions = { identity:Boolean(options.ecoOptions?.identity), tax:Boolean(options.ecoOptions?.tax), shop:Boolean(options.ecoOptions?.shop), cleaning:Boolean(options.ecoOptions?.cleaning) };
      const cleaningMinutes = includeEco && ecoOptions.cleaning ? 33 : 0;
      const ecoMinutes = includeEco ? (ecoOptions.identity ? 6 : 0) + (ecoOptions.tax ? moduleData.tax.min : 0) + (ecoOptions.shop ? 4 : 0) + cleaningMinutes : 0;
      const ecoOperations = ecoAnnualStays;
      const automationAnnualHours = accessOperations * minutesPerUse / 60;
      const ecoAnnualHours = ecoOperations * ecoMinutes / 60;
      const annualOperations = accessOperations + ecoOperations;
      const annualStays = annualOperations;
      const annualHours = automationAnnualHours + ecoAnnualHours;
      const monthlyHours = annualHours / 12;
      const staffDays = annualHours / 7;
      const fte = annualHours / 1607;
      const acceptedCleaningStays = ecoOptions.cleaning ? ecoOperations : 0;
      const environmentalStays = Math.round(acceptedCleaningStays);
      const waterSavedLiters = environmentalStays * environmentalData.waterLitersPerAcceptedStay;
      const co2SavedKg = environmentalStays * environmentalData.co2KgPerAcceptedStay;
      return { includeAccess, includeEco, totalMinutes:(includeAccess?minutesPerUse:0)+ecoMinutes, ecoMinutes, cleaningMinutes, automationMinutes:includeAccess?minutesPerUse:0, annualStays, annualOperations, accessOperations, ecoOperations, annualHours, ecoAnnualHours, automationAnnualHours, monthlyHours, staffDays, fte, grossSavings:0, netSavings:0, paybackMonths:null, costPerStay:0, averageStayNights, waterSavedLiters, co2SavedKg, acceptedCleaningStays, accessCount, accessOccupancyPercent, ecoRoomCount, ecoOccupancyPercent, ecoAcceptancePercent, ecoPotentialStays, ecoAnnualStays, ecoOptions };
    }
    const averageStayNights = Math.max(1, Number(options.averageStayNights) || 3);
    const ecoInterventionsAvoided = modules.includes('eco') ? Math.max(0, averageStayNights - Math.ceil(averageStayNights / 3)) : 0;
    const ecoMinutes = ecoInterventionsAvoided * (45 + 10);
    const automationMinutes = modules.filter(key => key !== 'eco').reduce((sum, key) => sum + (moduleData[key]?.min || 0), 0);
    const totalMinutes = ecoMinutes + automationMinutes;
    const adoption = Math.max(0, Math.min(100, Number(options.adoptionPercent) || 0)) / 100;
    const roomCount = Math.max(0, Number(options.roomCount) || 0);
    const occupancy = Math.max(0, Math.min(100, Number(options.occupancyPercent) || 0)) / 100;
    const derivedStays = roomCount > 0 ? roomCount * occupancy * 365 / averageStayNights : Math.max(0, Number(options.arrivalsPerDay) || 0) * 365;
    const annualStays = derivedStays * adoption;
    const annualHours = annualStays * totalMinutes / 60;
    const ecoAnnualHours = annualStays * ecoMinutes / 60;
    const automationAnnualHours = annualStays * automationMinutes / 60;
    const monthlyHours = annualHours / 12;
    const staffDays = annualHours / 7;
    const fte = annualHours / 1607;
    const grossSavings = annualHours * Math.max(0, Number(options.hourlyRate) || 0);
    const netSavings = grossSavings - Math.max(0, Number(options.annualLicense) || 0);
    const implementationCost = Math.max(0, Number(options.implementationCost) || 0);
    const paybackMonths = netSavings > 0 ? implementationCost / netSavings * 12 : null;
    const costPerStay = totalMinutes / 60 * Math.max(0, Number(options.hourlyRate) || 0);
    const waterSavedLiters = modules.includes('eco') ? annualStays * environmentalData.waterLitersPerAcceptedStay : 0;
    const co2SavedKg = modules.includes('eco') ? annualStays * environmentalData.co2KgPerAcceptedStay : 0;
    return { totalMinutes, ecoMinutes, automationMinutes, annualStays, annualHours, ecoAnnualHours, automationAnnualHours, monthlyHours, staffDays, fte, grossSavings, netSavings, paybackMonths, costPerStay, averageStayNights, waterSavedLiters, co2SavedKg };
  }

  return { calculate, moduleData, environmentalData };
});
