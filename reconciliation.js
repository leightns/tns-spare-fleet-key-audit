// Reconcile a confirmed list of vehicle numbers (the chip list from the central
// reviewer) against the expected roster for a given hub, returning four buckets
// + a derived action-items list.
//
// Inputs:
//   chipList:  array of strings, possibly with trailing "?" for uncertainty
//   hub:       the hub being audited (e.g. "CT - Fairfield")
//   roster:    array of vehicle records as loaded from vehicle_roster.csv
//
// Output:
//   {
//     buckets: {
//       belongHere:      [{ vehicle_number, current_address }],
//       belongElsewhere: [{ vehicle_number, assigned_location, current_address }],
//       offboarded:      [{ vehicle_number, reason, current_address? }],
//       missing:         [{ vehicle_number, current_address }],
//     },
//     actionItems: [
//       { actionType: 'move'   , vehicleNumber, sourceHub, destinationHub } |
//       { actionType: 'locate' , vehicleNumber, sourceHub                 } |
//       { actionType: 'remove' , vehicleNumber, sourceHub                 }
//     ]
//   }
function reconcile(chipList, hub, roster) {
  const clean = (chipList || []).map(n => String(n).replace(/\?$/, "").trim()).filter(Boolean);
  const cleanSet = new Set(clean);

  const buckets = { belongHere: [], belongElsewhere: [], offboarded: [], missing: [] };

  clean.forEach(num => {
    const vehicle = roster.find(v => v.vehicle_number === num);
    if (!vehicle) {
      buckets.offboarded.push({ vehicle_number: num, reason: "Not in roster" });
    } else if (vehicle.status === "offboard") {
      buckets.offboarded.push({
        vehicle_number: num,
        reason: "Offboarded",
        current_address: vehicle.current_address,
      });
    } else if (vehicle.assigned_location === hub) {
      buckets.belongHere.push({
        vehicle_number: vehicle.vehicle_number,
        current_address: vehicle.current_address,
      });
    } else {
      buckets.belongElsewhere.push({
        vehicle_number: vehicle.vehicle_number,
        assigned_location: vehicle.assigned_location,
        current_address: vehicle.current_address,
      });
    }
  });

  // Anything assigned-here-and-active but not in the chip list is missing.
  roster
    .filter(v => v.assigned_location === hub && v.status === "active")
    .forEach(v => {
      if (!cleanSet.has(v.vehicle_number)) {
        buckets.missing.push({
          vehicle_number: v.vehicle_number,
          current_address: v.current_address,
        });
      }
    });

  const actionItems = [
    ...buckets.belongElsewhere.map(v => ({
      actionType: "move",
      vehicleNumber: v.vehicle_number,
      sourceHub: hub,
      destinationHub: v.assigned_location,
    })),
    ...buckets.missing.map(v => ({
      actionType: "locate",
      vehicleNumber: v.vehicle_number,
      sourceHub: hub,
    })),
    ...buckets.offboarded.map(v => ({
      actionType: "remove",
      vehicleNumber: v.vehicle_number,
      sourceHub: hub,
    })),
  ];

  return { buckets, actionItems };
}

module.exports = { reconcile };
